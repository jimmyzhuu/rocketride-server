# Audio TTS Node (`audio_tts`)

Text-to-speech node with **Kokoro-82M** (local or `--modelserver`) plus the
**OpenAI** and **ElevenLabs** cloud engines. Engine selection is driven by
the `engine` field of the active profile in `services.json`.

## Supported engines

| Profile      | Engine field | Backend                                                          | Output  |
| ------------ | ------------ | ---------------------------------------------------------------- | ------- |
| `kokoro`     | `kokoro`     | Local `KPipeline` or remote `KokoroLoader` (`--modelserver`)     | WAV     |
| `openai`     | `openai`     | HTTPS POST to `api.openai.com/v1/audio/speech`                   | MP3/WAV |
| `elevenlabs` | `elevenlabs` | HTTPS POST to `api.elevenlabs.io/v1/text-to-speech/{voice_id}`   | MP3     |

Cloud engines run **directly on the engine host** and never go through the
model server.

## Behavior

- **Input:** `text`, `documents`, `questions`, `answers` lanes
- **Output:** `audio` lane via `writeAudio` (BEGIN / WRITE / END)
  - `audio/wav` for Kokoro
  - `audio/mpeg` for ElevenLabs and OpenAI (default `mp3`)
- **Kokoro local:** `kokoro.KPipeline`, spaCy `en_core_web_sm` via
  `ensure_spacy_en_model()`
- **Kokoro `--modelserver`:** `ModelClient` + `KokoroLoader` on the server

## Configuration

- Profile **`kokoro`** — `kokoro_voice` dropdown. Language code derived from
  the voice prefix (`af_*` → `a`, `ef_*` → `e`, etc.).
- Profile **`openai`** — `openai_model`, `openai_voice`, `api_key`. Falls
  back to `OPENAI_API_KEY` when `api_key` is blank.
- Profile **`elevenlabs`** — `elevenlabs_model`, `elevenlabs_voice`,
  `api_key`. Falls back to `ELEVENLABS_API_KEY` when `api_key` is blank.

The default profile is **`kokoro`**, so existing pipelines keep working
without changes.

## Dependencies

See `requirements.txt`: `numpy`, `kokoro`, `soundfile`, `requests`. Cloud
engines only require `requests`; the Kokoro stack is still pulled in on
first use via `depends()`.

## API keys

Cloud engines require an API key, supplied via:

1. The `api_key` field of the profile (UI / pipeline connector config), or
2. The environment variables `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` when
   the field is blank.

No other config locations are searched.

## Troubleshooting (`Exception: 1` / wasabi)

If misaki/spaCy initialization fails for Kokoro, the node uses the same
`spacy_en_model` helper as the reference branch — re-running with the
model server avoids the local spaCy install entirely.
