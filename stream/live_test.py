"""Feasibility: feed a WAV to the streaming speaker-attributed pipeline in 100 ms
pieces (like a microphone) and measure per-step compute vs audio hop, VRAM, and
the final speaker-attributed transcript.

Session loop adapted from nvidia/Nemotron-3-Diarization ASR_INTEGRATION_GUIDE.md.
Usage: python live_test.py <wav16k-mono> <mt|n35> [max_spks]
  mt  = nvidia/multitalker-parakeet-streaming-0.6b-v1 (English, masked_asr=false, [70,13])
  n35 = nvidia/nemotron-3.5-asr-streaming-0.6b (multilingual, masked_asr=true, [56,13])
"""
import json
import sys
import time

import numpy as np
import soundfile as sf
import torch
from omegaconf import OmegaConf

import nemo.collections.asr as nemo_asr
from nemo.collections.asr.models.sortformer_diar_models import SortformerEncLabelModel
from nemo.collections.asr.parts.utils.multispk_transcribe_utils import (
    SpeakerTaggedASR,
    configure_diar_streaming,
    validate_feature_frame_strides,
)
from nemo.collections.asr.parts.utils.streaming_utils import CacheAwareStreamingAudioBuffer

WAV, MODE = sys.argv[1], sys.argv[2]
MAX_SPKS = int(sys.argv[3]) if len(sys.argv) > 3 else 4
ASR = {"mt": "nvidia/multitalker-parakeet-streaming-0.6b-v1",
       "n35": "nvidia/nemotron-3.5-asr-streaming-0.6b"}[MODE]
import os
ATT = [int(x) for x in os.environ["ATT"].split(",")] if os.environ.get("ATT") else ([70, 13] if MODE == "mt" else [56, 13])
DIAR = "nvidia/Nemotron-3-Diarization"
dev = "cuda"

t0 = time.time()
asr_model = nemo_asr.models.ASRModel.from_pretrained(ASR)
diar_model = SortformerEncLabelModel.from_pretrained(DIAR)
asr_model.eval().to(dev)
diar_model.eval().to(dev)
asr_model.encoder.set_default_att_context_size(ATT)
if hasattr(asr_model, "set_inference_prompt"):   # Nemotron 3.5: language-ID prompt
    asr_model.set_inference_prompt(sys.argv[4] if len(sys.argv) > 4 else "auto")
validate_feature_frame_strides(asr_model=asr_model, diar_model=diar_model)
load_s = time.time() - t0
torch.cuda.synchronize()
weights_gb = torch.cuda.memory_allocated() / 2**30

cfg = OmegaConf.create({
    "device": dev, "sample_rate": 16000, "deploy_mode": True, "streaming_mode": True,
    "max_num_of_spks": MAX_SPKS, "batch_size": 32, "parallel_speaker_strategy": True,
    "masked_asr": MODE == "n35", "mask_preencode": False, "single_speaker_mode": False,
    "cache_gating": True, "cache_gating_buffer_size": 2, "binary_diar_preds": True,
    "spkcache_len": None, "spkcache_update_period": 222, "fifo_len": 264,
    "diar_right_context": 0, "att_context_size": ATT, "use_amp": True, "precision": "bf16",
    "online_normalization": False, "pad_and_drop_preencoded": False, "feat_len_sec": 0.01,
    "discarded_frames": 8, "word_window": 50, "sent_break_sec": 1.0,
    "fix_prev_words_count": 5, "update_prev_words_sentence": 5, "left_frame_shift": -1,
    "right_frame_shift": 0, "min_sigmoid_val": 1e-2, "ignored_initial_frame_steps": 5,
    "generate_realtime_scripts": True, "print_sample_indices": [0], "colored_text": False,
    "verbose": False, "print_time": False, "log": False, "target_lang": "auto",
})
sc = asr_model.encoder.streaming_cfg
configure_diar_streaming(diar_model=diar_model, cfg=cfg,
                         output_subsampling_factor=asr_model.encoder.subsampling_factor,
                         diar_chunk_len=sc.valid_out_len + sc.cache_drop_size)
cfg.spkcache_len = int(diar_model.sortformer_modules.spkcache_len)
streamer = SpeakerTaggedASR(cfg, asr_model, diar_model)
abuf = CacheAwareStreamingAudioBuffer(model=asr_model, online_normalization=False)

stride = float(asr_model.cfg.preprocessor.window_stride)
hop = round(sc.valid_out_len * asr_model.encoder.subsampling_factor * stride * 16000)
cache_frames = sc.pre_encode_cache_size
cache_frames = cache_frames[-1] if isinstance(cache_frames, (list, tuple)) else cache_frames
cache = round(cache_frames * stride * 16000)
frame = hop + cache

audio, sr = sf.read(WAV, dtype="float32")
assert sr == 16000 and audio.ndim == 1, "need 16 kHz mono"
pending = np.zeros(cache, dtype=np.float32)
step, step_times, latest = 0, [], None
torch.cuda.reset_peak_memory_stats()
piece = 1600  # 100 ms
with torch.inference_mode():
    for i in range(0, len(audio), piece):
        pending = np.concatenate([pending, audio[i:i + piece]])
        while len(pending) >= frame:
            f = pending[:frame]; pending = pending[hop:]
            ts = time.perf_counter()
            ca, cl = abuf.preprocess_audio(f)
            ca = ca[:, :, :cl[0]]
            drop = 0 if step == 0 else sc.drop_extra_pre_encoded
            latest = streamer.perform_parallel_streaming_stt_spk(
                step_num=step, chunk_audio=ca, chunk_lengths=cl,
                is_buffer_empty=False, drop_extra_pre_encoded=drop)
            torch.cuda.synchronize()
            step_times.append(time.perf_counter() - ts)
            step += 1

audio_s = len(audio) / 16000
hop_s = hop / 16000
st = np.array(step_times[1:]) if len(step_times) > 1 else np.array(step_times)
res = {
    "mode": MODE, "asr": ASR, "max_spks": MAX_SPKS, "att_context": ATT,
    "load_s": round(load_s, 1), "audio_s": audio_s, "hop_s": round(hop_s, 3),
    "lookahead_s": round((ATT[1] + 1) * 0.08, 2),
    "steps": step, "step_ms_p50": round(float(np.percentile(st, 50)) * 1000, 1),
    "step_ms_p95": round(float(np.percentile(st, 95)) * 1000, 1),
    "step_ms_max": round(float(st.max()) * 1000, 1),
    "rtf": round(sum(step_times) / audio_s, 3),
    "weights_gb": round(weights_gb, 2),
    "peak_alloc_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2),
    "peak_reserved_gb": round(torch.cuda.max_memory_reserved() / 2**30, 2),
}
print("RESULT " + json.dumps(res))
print("TRANSCRIPT_START")
print(latest[0] if latest else "")
print("TRANSCRIPT_END")
