# HAPI

Voice interface combining speech-to-text (STT) and text-to-speech (TTS) for hands-free AI interaction. Enables
voice-based queries, task creation, and knowledge lookups.

## Requirements

- STT provider: Whisper (local via whisper.cpp) or Deepgram (cloud API)
- TTS provider: ElevenLabs, OpenAI TTS, or Piper (local)
- Audio input device (microphone) and output device (speaker)
- Python 3.9+ or Node.js 18+ (depending on implementation)

## Setup

### Option A: Local (Whisper + Piper)

1. Install Whisper for STT:
   ```bash
   pip install openai-whisper
   # Or for faster inference with whisper.cpp:
   brew install whisper-cpp
   ```
2. Install Piper for TTS:
   ```bash
   pip install piper-tts
   # Download a voice model:
   piper --download-voice en_US-lessac-medium
   ```
3. No API keys needed -- runs entirely on your machine

### Option B: Cloud (Deepgram + ElevenLabs)

1. Get a Deepgram API key from [console.deepgram.com](https://console.deepgram.com)
2. Get an ElevenLabs API key from [elevenlabs.io](https://elevenlabs.io)
3. Store both keys in your vault:
   ```bash
   op item create --category=login --title="Deepgram - API Key" \
     --vault="AI" api_key="your-key"
   op item create --category=login --title="ElevenLabs - API Key" \
     --vault="AI" api_key="your-key"
   ```

### Pipeline Configuration

4. Set up the voice pipeline:
   ```
   Microphone -> STT (speech to text) -> AI Agent -> TTS (text to speech) -> Speaker
   ```
5. Configure activation mode:
   - **Wake word**: Always listening, activates on a keyword (e.g., "Hey assistant")
   - **Push-to-talk**: Activates only when a button is pressed (lower resource usage)
6. Deploy as a systemd service for always-on availability

## Provider Comparison

| Provider        | Type | Latency | Cost              | Privacy         |
| --------------- | ---- | ------- | ----------------- | --------------- |
| Whisper (local) | STT  | ~1-3s   | Free              | Full privacy    |
| Deepgram        | STT  | ~300ms  | Pay per minute    | Cloud processed |
| Piper (local)   | TTS  | ~200ms  | Free              | Full privacy    |
| ElevenLabs      | TTS  | ~500ms  | Pay per character | Cloud processed |
| OpenAI TTS      | TTS  | ~400ms  | Pay per character | Cloud processed |

## Use Cases

- Hands-free AI interaction while cooking, driving, or exercising
- Voice-based task creation ("Add a task to review the budget by Friday")
- Quick knowledge lookups without opening a terminal
- Accessibility interface for users who prefer voice over typing
- Morning briefing read aloud while getting ready
