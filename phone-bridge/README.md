# phone-bridge (Worker g4f4r0-axo)

A Cloudflare Worker and Durable Object that lets Johan talk to Axo (thread GFR-4) by phone, and lets Axo phone Johan.
Telnyx Call Control does the audio (speech to text and text to speech), so the Worker only handles HTTPS webhooks. Every turn of a call is a message in the Capy thread, so the thread is the call history.

```mermaid
sequenceDiagram
  participant J as Johan's mobile
  participant T as Telnyx
  participant W as Worker + Durable Object
  participant C as Capy thread GFR-4
  J->>T: calls the number
  T->>W: call.initiated (signed)
  W->>C: start message (only if the caller is ALLOWED_CALLER, else reject)
  C-->>W: Axo's greeting over GET /threads/{id}/stream
  W->>T: answer, then speak the greeting
  T->>W: call.transcription (final text)
  W->>C: POST /threads/{id}/message
  C-->>W: each reply message as it commits
  W->>T: speak it
  T->>J: Axo's voice
```

## Behaviour

- Inbound: only `ALLOWED_CALLER` is answered. Any other number, and anonymous callers, are rejected with a Telnyx `reject` before anything reaches Axo.
- Every webhook is verified with Telnyx's Ed25519 signature (`telnyx-signature-ed25519`, `telnyx-timestamp`, five minute replay window). A failed check returns 401 and nothing is processed.
- A call opens with a `[Channel: Phone call] [Event: Incoming call] [From: Johan] [Time: <time>]` message naming the caller, the local time and how to talk on the phone. The phone keeps ringing until Axo's greeting lands, so the first thing Johan hears is Axo; after `CALL_GREETING_TIMEOUT_SECONDS` (Axo can take about 10 seconds to wake) the bridge answers with "Hey Johan." and speaks Axo's greeting when it arrives.
- What Johan says is sent as `[Channel: Phone call] [From: Johan] ...` with `interrupt` delivery. The bridge reads the thread's live stream and speaks each finished sentence of Axo's reply as it is written, before the message commits, cleaned of markdown and links and cut at `CALL_MAX_SPOKEN_CHARS`. If Axo starts a tool before saying anything, a short filler plays at once. A reply that lands just after Johan says something else is still spoken. Sends to Capy time out after 3 seconds and retry once with the same client key, which Capy deduplicates.
- His words are sent once he has been quiet for one second; interim transcripts keep the turn open while he is still talking, so a pause mid-sentence does not split it. If he talks over Axo (two words or more), playback stops, the rest of that reply is dropped, and his words go to Axo. Single-word backchannels while Axo talks, and transcripts that match what the bridge just said, are ignored as echo.
- Every call message switches Axo to `CAPY_CALL_MODEL_ID` at `CAPY_CALL_REASONING_MODE`, adding fast mode when `CAPY_CALL_FAST_MODE` is on and the model catalog offers it. The call-ended message switches it back to `CAPY_DEFAULT_MODEL_ID` at `CAPY_DEFAULT_REASONING_MODE`, including when the bridge ends the call itself. If Capy rejects the selection, the message is sent without it. All of these live in `[vars]` in `wrangler.toml`, so switching models is a one-line change and a deploy.
- After `CALL_IDLE_SECONDS` of silence Axo is asked to check in; after another `CALL_IDLE_SECONDS` it says goodbye and the call hangs up. When a call ends, a `[Channel: Phone call] [Event: Call ended] [Duration: <duration>] [Ended by: <who>]` message is queued in the thread.
- Hold: when Axo knows work will be long it ends a line with `[Hold]` ("Let me run the tests. [Hold]"). The bridge speaks the line without the tag and starts looping hold music from `HOLD_MUSIC_URL` as soon as it finishes. Quick answers get no music. If Axo has said nothing after `HOLD_FILLER_AFTER_SECONDS` the caller hears a short natural filler such as "Mm, let me see.", and if Axo stays quiet for `HOLD_MUSIC_AFTER_SECONDS` the music starts anyway. The music stops when Axo's next message lands or Johan talks. After `CALL_REPLY_TIMEOUT_SECONDS` with no reply at all the call ends with a note that the answer will be in the thread.
- The hold music is "Local Forecast - Elevator" by Kevin MacLeod (incompetech.com), licensed under Creative Commons Attribution 4.0, served from `public/hold.mp3` as a Workers static asset.
- Hard caps: a call ends after `CALL_MAX_SECONDS` (default 600) and at most `OUTBOUND_MAX_CALLS_PER_DAY` (default 10) outbound calls are placed per calendar day in `TIMEZONE`. Rejected and unauthorized attempts do not count.
- The bridge speaks every assistant message that lands in the thread after the message it sent. If another agent wakes Axo during a call, that unrelated reply is spoken too.

## Outbound calls (how Axo phones Johan)

```bash
curl -X POST https://g4f4r0-axo.<account-subdomain>.workers.dev/call \
  -H "Authorization: Bearer $OUTBOUND_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "The nightly backup failed twice.", "listen": true}'
```

- `text` (required, at most 1000 characters) is spoken when Johan answers.
- `listen` (optional, default false). When true the call stays open after the alert and whatever Johan answers is sent into GFR-4 with the alert as context, then Axo's reply is spoken, turn by turn. When false the call hangs up after the alert.
- Responses: `202` call is being placed, `401` missing or wrong token (no call is placed), `400` bad body, `429` daily limit reached, `502` Telnyx refused the call.

The call always goes to `ALLOWED_CALLER`; the endpoint cannot dial anything else.

## Configuration

Plain variables live in `wrangler.toml` and can be changed per deploy:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CALL_LANGUAGE` | `en` | `en` or `es`: speech recognition language, voice, fixed phrases, and the language Axo is asked to answer in |
| `CALL_MAX_SECONDS` | `600` | Hard cap on one call |
| `OUTBOUND_MAX_CALLS_PER_DAY` | `10` | Hard cap on outbound calls per day |
| `HOLD_FILLER_AFTER_SECONDS` | `6` | Silence from Axo before "One moment." when it has said nothing yet |
| `HOLD_MUSIC_AFTER_SECONDS` | `15` | Silence from Axo before music starts without a `[Hold]` tag |
| `HOLD_MUSIC_URL` | the Worker's `/hold.mp3` | MP3 or WAV looped during hold; empty disables music |
| `CALL_REPLY_TIMEOUT_SECONDS` | `300` | How long to wait for Axo before giving up |
| `CALL_MAX_SPOKEN_CHARS` | `700` | Longest reply read aloud per message |
| `CAPY_THREAD_ID` | GFR-4's id | Thread that receives the calls |
| `CAPY_CALL_MODEL_ID` | Axo's model | Model Axo runs on during a call (set to `anthropic/claude-opus-5-5`) |
| `CAPY_CALL_REASONING_MODE` | `low` | Reasoning during a call; `off` leaves Axo's model untouched |
| `CAPY_CALL_FAST_MODE` | `true` | Use fast mode during a call when the call model offers it on this account |
| `CAPY_DEFAULT_MODEL_ID` | the thread's last model | Model restored when the call ends (set to `anthropic/claude-sonnet-5-5`) |
| `CAPY_DEFAULT_REASONING_MODE` | `high` | Reasoning restored when the call ends |
| `CALL_IDLE_SECONDS` | `20` | Silence before Axo checks in, and again before it says goodbye |
| `CALL_GREETING_TIMEOUT_SECONDS` | `20` | Longest ring before answering without Axo's greeting |
| `CALLER_NAME` | `Johan` | Name used in the start message and fallback greeting |
| `TELNYX_STT_KEYTERMS` | `Axo,Capy,Johan,g4f4r0,Telnyx,Cloudflare,GitHub` | Words speech recognition is biased toward |
| `TIMEZONE` | `Europe/Madrid` | Day boundary for the outbound cap |
| `TELNYX_VOICE`, `TELNYX_STT_ENGINE`, `TELNYX_STT_MODEL` | per language, `Deepgram`, `deepgram/nova-3` | Telnyx voice and transcription engine overrides |
| `TELNYX_CONNECTION_ID` | set in `wrangler.toml` | Id of the Telnyx Call Control application (named g4f4r0-axo) the number is assigned to |

## Secrets

Set with `wrangler secret put <NAME>` (or through the Cloudflare API). Never commit them. A secret set before the first deploy is lost, so deploy first.

| Secret | What it is |
| --- | --- |
| `TELNYX_API_KEY` | Telnyx API v2 key |
| `TELNYX_PUBLIC_KEY` | Telnyx account public key (Mission Control, Keys and Credentials, Public Key); base64 Ed25519 |
| `CAPY_API_KEY` | Capy API key that can write to and read from the GFR-4 thread (Settings, API) |
| `TELNYX_NUMBER` | The purchased Telnyx number in E.164, used as the caller id of outbound calls |
| `ALLOWED_CALLER` | Johan's mobile in E.164, the only number that is answered and the number outbound calls go to |
| `OUTBOUND_TOKEN` | Random bearer token for `POST /call`; generate with `openssl rand -hex 32` |

## Setup and deploy

1. In Telnyx create a Call Control application (webhook API version v2) whose webhook URL is `https://g4f4r0-axo.<account-subdomain>.workers.dev/telnyx/webhook`, and assign the purchased number to it.
2. `cd phone-bridge && npm install`
3. Set `TELNYX_CONNECTION_ID` in `wrangler.toml` and put the six secrets above with `wrangler secret put`.
4. `npm run deploy`

## Development

`npm test` runs the unit tests (signature check, caller allowlist, outbound auth, caps, call flow); `npm run typecheck` checks the types.
