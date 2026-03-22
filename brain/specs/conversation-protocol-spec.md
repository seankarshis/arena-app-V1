# Conversation Protocol Specification (v3)

## Document Purpose

This is the authoritative specification for the runtime conversation protocol during an interview session. It covers the exact message exchange pattern between the frontend, backend, STT service, LLM, and TTS service — from interview start to completion. It is a companion to `interview-spec-v1.md` (data model, GraphQL schema, infrastructure) and supersedes any conflicting implied behavior in that document.

This document is intended to be consumed by Claude Code in planning mode alongside the interview spec.

### Change Log

**v3** addresses six engineering review items:
1. **Items 6 & 10 (user_templates):** Replaced the `user_templates` junction table with a `current_template_id` FK on the `users` table plus a new `template_assignment_history` table for audit. Users can always view past interviews regardless of current template assignment.
2. **Item 7 (no delete mutations):** Established explicit policy: tags and questions are never hard-deleted. Added `is_active` boolean field to both tables. Deactivation removes items from selection UIs without breaking historical associations.
3. **Item 14 (follow-up trigger evaluation):** Specified that the LLM evaluates all follow-up triggers. Trigger definitions are passed in the system prompt. No application-side keyword matching, sentiment analysis, or length checking services.
4. **Item 15 (WebSocket authentication):** Specified JWT-based authentication for the STT WebSocket via query parameter on initial connection, with interview session cross-referencing.
5. **Item 25 (reconciliation job):** Consolidated all reconciliation tasks into a single Lambda on an EventBridge scheduled rule (every 15 minutes), defined in the Compute Stack CDK. Handles stuck cleaning states, failed audio uploads, and paused interview auto-abandonment.

**v2** resolved the audio architecture conflict: per-response segments via push-to-talk with progressive background upload. See Section 2 for full details.

---

## 1. Architecture Overview

### Three Communication Channels

An active interview session uses three distinct communication channels. They are **not** multiplexed over a single connection.

| Channel | Transport | Purpose | Lifecycle |
|---|---|---|---|
| **STT Channel** | WebSocket (authenticated) | Streams microphone audio to ElevenLabs STT via Fargate proxy; returns transcribed text in real-time | Opens when push-to-talk is pressed, closes when released |
| **LLM Channel** | Streaming HTTP (SSE) | Sends user's committed response text to the backend; streams the LLM's next question back token-by-token | One request-response per conversational turn |
| **TTS Channel** | REST (frontend-initiated) | Frontend sends LLM response text to ElevenLabs TTS API; receives synthesized audio for playback | One request per LLM response, may be split into sentence-level chunks for low-latency playback |

### Why This Architecture

- **STT WebSocket** is required because audio streaming needs a persistent, bidirectional connection. This was already specified in interview-spec-v1.md.
- **LLM via streaming HTTP (SSE)** instead of a second WebSocket because each LLM turn is a discrete request-response. SSE gives token-by-token streaming without the overhead of managing a persistent conversation socket. The backend holds the conversation state in Redis — the HTTP connection does not need to persist between turns.
- **TTS on the frontend** because the frontend can begin synthesizing audio as soon as the first complete sentence arrives from the LLM stream, without waiting for the full response. This eliminates a round-trip through the backend and enables overlapped streaming: text appears on screen while audio begins playing.

### ElevenLabs Usage

ElevenLabs is the sole vendor for both STT and TTS. A single default voice is used for all TTS output in v1. Configurable voice selection per engagement or per template is deferred to a future version.

- **STT API**: Real-time WebSocket streaming endpoint, proxied through Fargate
- **TTS API**: REST endpoint called directly from the frontend with sentence-level chunks
- **API key management**: Both STT and TTS keys stored in AWS Secrets Manager. The STT key is used by the Fargate proxy (backend). The TTS key must be accessible to the frontend — deliver it via a short-lived token endpoint on the backend (see Section 9: Security Considerations).

---

## 2. Audio Architecture

### The Core Decision: Per-Response Audio Segments via Push-to-Talk

The push-to-talk interaction model naturally creates discrete, per-response audio segments. Each time the user presses the PTT button, a new recording begins. When they release it, the recording ends. This IS the audio segment for that response. There is no continuous recording to slice.

This resolves the timing problem identified in engineering review: the per-response audio fields on `interview_responses` (s3_audio_key, audio_duration_seconds, etc.) are meaningful because each response genuinely has its own audio file.

**What gets recorded:**
- Only the user's speech while PTT is held. The LLM's TTS output is NOT recorded.
- Text-only responses (typed) have no audio — audio fields are null for those responses.

### Client-Side Recording Architecture

```
User presses PTT
    │
    ├── MediaRecorder starts IMMEDIATELY (WebM/Opus or WAV format)
    │   Records to an in-memory buffer from the first audio sample.
    │   No dead time — recording begins before WebSocket is established.
    │
    ├── Simultaneously: WebSocket connection initiated (auth + STT session setup)
    │   Audio chunks accumulate in a local queue during WS handshake.
    │
    ├── On WS ready (session_ready received):
    │   Flush all queued audio chunks to the STT WebSocket in order,
    │   then switch to live streaming (chunks sent as they arrive).
    │   (Live transcription begins — partial results may arrive in a burst
    │   as the STT service processes the buffered audio.)
    │
    │   *** IMPORTANT: The frontend does NOT send buffered chunks directly
    │   to ElevenLabs. It sends them to the Fargate proxy, which handles
    │   flow-controlled delivery to the STT engine. See "Burst Handling
    │   Protocol" below. ***
    │
    ├── If WS connection fails:
    │   MediaRecorder continues — audio Blob is still captured locally.
    │   Frontend transitions to REVIEW with a warning (see Section 15:
    │   STT WebSocket Drops During Recording). No transcript available,
    │   but the user can type their response manually or redo.
    │
User releases PTT
    │
    ├── MediaRecorder stops → produces a Blob (the audio segment)
    │
    ├── STT WebSocket receives final transcript
    │
    ├── Frontend enters REVIEW state (transcript shown, Redo available)
    │
    ├── If auto-send fires (no Redo):
    │   ├── Audio Blob held in memory, tagged with response metadata
    │   └── Background upload queued (see Progressive Upload below)
    │
    └── If user clicks Redo:
        ├── Current audio Blob → draft upload queue (see Draft Audio below)
        └── New recording begins on next PTT press
```

### Burst Handling Protocol (Fargate Proxy)

When the frontend opens a new STT WebSocket connection, it may have accumulated several seconds of buffered audio chunks recorded by the MediaRecorder before the WebSocket handshake completed. The frontend flushes these buffered chunks to the Fargate proxy immediately after receiving `session_ready`. The Fargate proxy is responsible for flow-controlling this initial burst before forwarding it to the ElevenLabs STT API.

**Why this matters:** ElevenLabs STT (like most streaming STT providers) requires a `begin_stream` configuration message before accepting binary audio data, and its internal pipeline expects audio to arrive at roughly real-time pace during the initial moments of a session. If 2+ seconds of buffered audio are burst-sent immediately after the handshake, the STT engine may drop or misrecognize the initial frames — which often contain the most semantically critical content (e.g., a short "Yes" or "No" answer, or the subject of the first sentence).

**Protocol:**

1. **Frontend behavior (unchanged):** The frontend sends all buffered audio chunks to the Fargate proxy as fast as it can after `session_ready`. From the frontend's perspective, there is no throttling — it flushes the queue and then switches to live streaming.

2. **Fargate proxy responsibilities:**
   - On receiving the first WebSocket connection from the frontend, the proxy opens a session to the ElevenLabs STT WebSocket and sends the required `begin_stream` configuration message.
   - The proxy maintains a small **relay buffer** for the initial burst period.
   - Buffered audio chunks from the frontend are forwarded to ElevenLabs at a **metered rate of no faster than 1.5× real-time** during the burst phase. The "burst phase" lasts until the relay buffer is drained (i.e., the proxy has caught up with the frontend's live stream). For example, if the frontend flushes 2 seconds of audio in 50ms, the proxy forwards those 2 seconds of audio data over approximately 1.3 seconds (2s ÷ 1.5).
   - Once the relay buffer is drained, the proxy switches to **pass-through mode** — subsequent chunks from the frontend are forwarded to ElevenLabs immediately as they arrive (they are already arriving at real-time pace from the MediaRecorder).
   - The 1.5× rate is a starting configuration. Log the following during the burst phase for tuning: total buffered duration, number of chunks, time to drain, and whether the first `partial_transcript` from ElevenLabs includes recognizable content. If the first partial transcript is consistently empty or garbled, reduce the rate toward 1.0×.

3. **Latency impact:** The metered relay adds a brief delay to the first partial transcript. For a typical 1–2 second buffer, the added latency is under 1 second. This is acceptable because the user has just released the PTT button or is still holding it — they are not yet waiting for a response. The tradeoff (slightly delayed first partial transcript vs. dropped initial speech) strongly favors reliability.

4. **Edge case — very long buffer (>3 seconds):** If the WebSocket handshake takes unusually long and the buffer exceeds 3 seconds of audio, the proxy still meters at 1.5× real-time. A 3-second buffer drains in ~2 seconds. The proxy does NOT skip or truncate buffered audio under any circumstances — all captured audio must reach the STT engine.

5. **Partial transcript relay:** While the proxy is metering the burst, partial transcripts from ElevenLabs are forwarded to the frontend immediately (no buffering on the return path). The frontend may see a burst of partial transcript updates once the STT engine begins processing.

### Progressive Background Upload

Audio segments upload to S3 **in the background** while the interview continues. This provides resilience against browser crashes and avoids a large batch upload at the end.

### Maximum Recording Duration

A single PTT recording is capped at **5 minutes**. This prevents excessively large audio Blobs, controls ElevenLabs STT session costs, and avoids potential STT service timeouts.

**Enforcement:**
1. Frontend starts a countdown timer when MediaRecorder begins.
2. At **4 minutes** (80% of limit): frontend shows a subtle visual warning on the PTT button area — e.g., the recording indicator changes color or a "1 min remaining" label appears. No audio interruption.
3. At **5 minutes**: frontend automatically triggers the same sequence as a manual PTT release — MediaRecorder stops, audio Blob is captured, `audio_end` is sent on the WebSocket, and the frontend transitions to REVIEW with the full 5-minute recording.
4. The user sees the same REVIEW experience as a normal release — they can accept, redo, or edit the transcript.
5. No backend enforcement is needed — the STT WebSocket session simply receives the `audio_end` message as usual. If for any reason the frontend fails to enforce the limit and the STT session exceeds 5 minutes, the backend should close the WebSocket with a `recording_too_long` error code after 6 minutes (safety margin) and the frontend handles this as a WebSocket drop (Section 15).

**Why 5 minutes:** ElevenLabs STT sessions are billed per-second. A 5-minute cap balances giving users ample time for detailed responses against cost control and Blob size (~2.4 MB at 64kbps Opus). Interview responses rarely exceed 2-3 minutes in practice.

**Upload flow per response:**
1. When auto-send fires, the audio Blob is added to an upload queue managed by the frontend
2. Frontend requests a presigned S3 PUT URL from the backend: `requestResponseAudioUploadUrl(interviewId, responseId)`
3. Frontend uploads the Blob to S3 via the presigned URL in the background (using a Web Worker or fetch with low priority)
4. On successful upload, frontend calls `confirmAudioUpload(responseId, s3Key, mimeType, durationSeconds)` to update the response record
5. If upload fails: retry up to 3 times with exponential backoff. If still failing, queue for retry after the next successful turn. Log the failure but do not interrupt the interview.
6. The interview can complete even if some audio uploads are still in progress — the frontend continues uploading after the completion screen is shown

**S3 Key Structure:**
```
interviews/{interviewId}/responses/{responseId}/audio.webm
interviews/{interviewId}/drafts/{draftId}/audio.webm
```

### Draft Audio Upload

When the user clicks Redo, the discarded recording also uploads to S3 for debugging and STT quality analysis. Draft audio follows the same progressive upload pattern but uses a separate S3 prefix.

**Draft upload flow:**
1. User clicks Redo → current audio Blob tagged as draft
2. `saveDraft` mutation fires (saves transcript to `response_drafts` table)
3. Frontend requests presigned URL: `requestDraftAudioUploadUrl(interviewId, draftId)`
4. Upload proceeds in background, same retry logic as committed responses
5. On success: `confirmDraftAudioUpload(draftId, s3Key, mimeType, durationSeconds)` updates the draft record

### Audio Lifecycle Policy

S3 lifecycle rules applied per prefix:

| Prefix | Glacier transition | Deletion |
|---|---|---|
| `interviews/{id}/responses/` | 90 days | 365 days |
| `interviews/{id}/drafts/` | 30 days | 90 days |

Draft audio has a shorter retention because its purpose is debugging, not archival.

### What This Replaces in interview-spec-v1.md

The original spec's Section 5 "Post-Interview Audio Upload" described a monolithic upload after interview completion. **That section is fully superseded by this document.** Specifically:
- There is NO single full-recording upload at interview completion
- There is NO need to slice a continuous recording into segments
- The `requestAudioUploadUrl(interviewId)` mutation from the original spec is replaced by per-response and per-draft presigned URL mutations
- The original spec's note that "Audio fields are populated after the interview when the full recording is uploaded to S3 for archival" is no longer accurate — audio fields are populated progressively during the interview

---

## 3. Frontend State Machine

The interview UI is a finite state machine. At any moment, the frontend is in exactly one of these states. Every UI element, button availability, and backend call is determined by the current state.

```
┌─────────────┐
│   READY      │  User sees the interview landing page. "Start Interview" button visible.
└──────┬──────┘
       │ User clicks "Start Interview"
       ▼
┌─────────────┐
│  STARTING    │  Frontend calls startInterview mutation. Loading indicator shown.
└──────┬──────┘
       │ Mutation returns successfully with first LLM question
       ▼
┌──────────────────┐
│  AWAITING_INPUT   │◄──────────────────────────────────────────────────┐
│                    │  LLM's question displayed at top of screen.       │
│                    │  Text input field + push-to-talk button active.   │
│                    │  Progress bar updated. Skip button visible.       │
└───┬──────┬───┬───┘                                                    │
    │      │   │                                                         │
    │      │   │ User clicks "Skip"                                      │
    │      │   └──────────────────────────┐                              │
    │      │                              ▼                              │
    │      │                     ┌────────────────┐                      │
    │      │                     │  SKIPPING       │ Backend records skip │
    │      │                     └───────┬────────┘                      │
    │      │                             │                               │
    │      │ User clicks push-to-talk    │                               │
    │      ▼                             │                               │
    │  ┌──────────────┐                  │                               │
    │  │  RECORDING    │ STT WebSocket    │                               │
    │  │               │ open (auth'd).  │                               │
    │  │               │ Audio streaming. │                               │
    │  │               │ MediaRecorder    │                               │
    │  │               │ capturing.       │                               │
    │  │               │ Live text appears│                               │
    │  └──────┬───────┘                  │                               │
    │         │ User releases button      │                               │
    │         │ MediaRecorder stops.      │                               │
    │         │ Audio Blob captured.      │                               │
    │         ▼                           │                               │
    │  ┌──────────────┐                  │                               │
    │  │  REVIEW       │ Transcribed text │                               │
    │  │               │ shown. "Redo"    │                               │
    │  │               │ button visible.  │                               │
    │  │               │ Auto-send timer  │                               │
    │  │               │ starts AFTER     │                               │
    │  │               │ final_transcript │                               │
    │  │               │ received and     │                               │
    │  │               │ displayed (~2s). │                               │
    │  │               │ Pauses if user   │                               │
    │  │               │ focuses text     │                               │
    │  │               │ field to edit    │                               │
    │  │               │ transcript.      │                               │
    │  └──┬───────┬───┘                  │                               │
    │     │       │ User clicks "Redo"    │                               │
    │     │       ▼                       │                               │
    │     │  ┌──────────────┐            │                               │
    │     │  │  REDO         │ Draft saved│                               │
    │     │  │               │ (text +    │                               │
    │     │  │               │ audio) to  │                               │
    │     │  │               │ DB and S3. │                               │
    │     │  │               │ Input field│                               │
    │     │  │               │ editable + │                               │
    │     │  │               │ PTT active.│                               │
    │     │  │               │ See "REDO  │                               │
    │     │  │               │ Mode-Switch│                               │
    │     │  │               │ Rules" for │                               │
    │     │  │               │ PTT + text │                               │
    │     │  │               │ interaction│                               │
    │     │  └──────┬───────┘            │                               │
    │     │         │ User submits (PTT   │                               │
    │     │         │ release or text     │                               │
    │     │         │ send) → back to     │                               │
    │     │         │ REVIEW              │                               │
    │     │         └─────────────────────┤                               │
    │     │                               │                               │
    │     │ Auto-send fires               │                               │
    │     ▼                               │                               │
    │  ┌──────────────┐                  │                               │
    │  │  PROCESSING   │ submitResponse   │                               │
    │  │               │ mutation fires.  │                               │
    │  │               │ Response saved   │                               │
    │  │               │ to DB. Audio     │                               │
    │  │               │ upload queued    │                               │
    │  │               │ in background.   │                               │
    │  └──────┬───────┘                  │                               │
    │         │ Mutation returns           │                               │
    │         ▼                           │                               │
    │  ┌──────────────┐                  │                               │
    │  │  LLM_STREAMING│ SSE stream open. │                               │
    │  │               │ LLM response     │                               │
    │  │               │ appears token by │                               │
    │  │               │ token. TTS auto- │                               │
    │  │               │ plays sentences. │                               │
    │  └──────┬───────┘                  │                               │
    │         │ Stream complete            │                               │
    │         │                            │                               │
    │         ├─── LLM signals more ──────┼───────────────────────────────┘
    │         │    questions remain        │
    │         │                            │
    │         ▼                            │
    │  ┌──────────────┐                  │
    │  │  COMPLETING   │ LLM signals all  │
    │  │               │ required Qs done │
    │  │               │ OR user clicks   │
    │  │               │ "End Interview"  │
    │  └──────┬───────┘                  │
    │         │                            │
    │         ▼                            │
    │  ┌──────────────┐                  │
    │  │  UPLOADING    │ completeInterview │
    │  │               │ mutation fires.  │
    │  │               │ Wait for any     │
    │  │               │ pending audio    │
    │  │               │ uploads to       │
    │  │               │ finish.          │
    │  └──────┬───────┘                  │
    │         │ All uploads confirmed      │
    │         ▼                            │
    │  ┌──────────────┐                  │
    │  │  COMPLETED    │ Summary shown.   │
    │  └──────────────┘                  │
    │                                      │
    │ User types text and hits Enter/Send  │
    └──────────────────────────────────────┘
      (skips RECORDING and REVIEW, goes
       directly to PROCESSING. No audio
       Blob captured for text input.)
```

### Additional States

| State | Trigger | Behavior |
|---|---|---|
| **PAUSED** | User clicks "Pause" (available in AWAITING_INPUT) | Interview state persisted to DB from Redis. Timer stops. Pending audio uploads continue in background. "Resume" button shown. Session can be resumed within 72 hours; after that, status auto-transitions to 'abandoned'. |
| **RESUMING** | User clicks "Resume" (from PAUSED or returning to an in_progress interview) | State reconstructed from DB into Redis. LLM context rebuilt from stored conversation history. Transitions to AWAITING_INPUT with the next unasked question. |
| **ERROR** | STT connection failure, LLM API error, network drop | Error message shown with retry option. Interview state preserved in Redis/DB. Audio uploads already queued continue retrying. Does not auto-abandon. |
| **MEDIA_ERROR** | Browser denies microphone permission or hardware is unavailable | Shown when the user attempts to press PTT and `getUserMedia` fails (e.g., `NotAllowedError`, `NotFoundError`, `NotReadableError`). The frontend displays a clear message explaining the issue: "Microphone access was denied. Please allow microphone access in your browser settings to use voice input, or type your response instead." The PTT button is disabled; the text input field remains active so the user can continue the interview via typing. If the user grants permission (detected via the Permissions API `change` event or a manual retry button), the frontend re-enables the PTT button and returns to AWAITING_INPUT. This state does NOT pause or abandon the interview — it is a degraded-input mode, not a session error. See "Microphone Permission and Hardware Handling" below for full details. |
| **IDLE_WARNING** | 60 seconds of inactivity in AWAITING_INPUT | LLM generates a gentle prompt ("Take your time — would you like me to rephrase the question?") delivered as text + TTS. Resets idle timer. |
| **AUTO_PAUSED** | 3 minutes of inactivity after IDLE_WARNING | Transitions to PAUSED automatically. "Your interview has been paused. Click Resume when you're ready to continue." |
| **UPLOADING** | Interview logic complete, pending audio uploads remain | Shown after completeInterview fires. Progress indicator for remaining uploads. Timeout after 60 seconds — if uploads haven't finished, show "Some audio is still uploading. It will complete in the background." and transition to COMPLETED anyway. |

### Microphone Permission and Hardware Handling

The frontend must request microphone access (`navigator.mediaDevices.getUserMedia`) before the user can record via PTT. This can fail for several reasons, and the state machine must handle each gracefully.

**When to request permission:**

The frontend requests microphone permission **eagerly on interview start** (during the STARTING → AWAITING_INPUT transition), not lazily on first PTT press. This ensures that any permission prompt or denial is surfaced before the user is mid-question, reducing surprise and frustration.

**Permission request flow:**

1. During the STARTING state (after `startInterview` returns but before transitioning to AWAITING_INPUT), the frontend calls `navigator.mediaDevices.getUserMedia({ audio: true })`.
2. **If granted:** Store the MediaStream reference (or immediately stop it and re-acquire on PTT press — browser-dependent). Transition to AWAITING_INPUT with PTT enabled.
3. **If denied or failed:** Transition to AWAITING_INPUT with PTT **disabled** and MEDIA_ERROR visual state applied to the PTT button area. Show a non-blocking banner: "Microphone access is unavailable. You can type your responses, or enable microphone access in your browser settings and click 'Retry.'" The interview is fully functional via text input.

**Failure modes and their mapping:**

| `getUserMedia` Error | User-Facing Message | PTT State | Recovery |
|---|---|---|---|
| `NotAllowedError` (user denied) | "Microphone access was denied. Please allow it in your browser settings to use voice input." | Disabled | "Retry Microphone" button re-calls `getUserMedia`. Also listen for `navigator.permissions.query({name: 'microphone'})` state changes where supported. |
| `NotFoundError` (no mic hardware) | "No microphone detected. Please connect a microphone to use voice input, or type your responses." | Disabled | "Retry Microphone" button. |
| `NotReadableError` (hardware busy/OS block) | "Your microphone is currently unavailable (it may be in use by another application). You can type your responses or try again." | Disabled | "Retry Microphone" button. |
| `OverconstrainedError` or other | "Microphone setup failed. You can type your responses or try again." | Disabled | "Retry Microphone" button. |

**PTT press when microphone is unavailable:**

If the PTT button is in the disabled/MEDIA_ERROR visual state and the user somehow clicks it (e.g., button is visible but grayed out), the frontend does NOT attempt to start a MediaRecorder. Instead, it shows a tooltip or inline message pointing to the "Retry Microphone" button or the browser settings instruction. No state transition occurs.

**Microphone failure mid-recording:**

If the MediaRecorder's `onerror` event fires during an active RECORDING state (e.g., the user unplugs their microphone), the frontend treats this identically to a WebSocket drop during recording (Section 15): stop the MediaRecorder, capture whatever partial Blob exists, transition to REVIEW with a warning, and disable PTT until the user clicks "Retry Microphone."

**Key principle:** Microphone issues never block the interview. The user can always fall back to text input. The MEDIA_ERROR state is a UI overlay on AWAITING_INPUT, not a terminal state.

### Auto-Send Timer and PTT Interaction in REVIEW State

The auto-send timer in REVIEW state must respect user intent signals beyond just text field focus. Specifically:

**PTT mousedown/touchstart kills the auto-send timer:** If the user presses the PTT button while in the REVIEW state (indicating intent to re-record rather than accept the current transcript), the auto-send timer is **immediately and unconditionally cancelled** on the `mousedown` (or `touchstart`) event — before the PTT press fully registers as a state transition to RECORDING. This prevents a race condition where the auto-send fires in the brief interval between the user deciding to re-record and the PTT press being processed.

**Complete auto-send timer rules (consolidated):**

| Event in REVIEW state | Timer behavior |
|---|---|
| `final_transcript` received and rendered | Timer **starts** (~2 second countdown) |
| User focuses the text field (click/tap into it) | Timer **pauses** |
| User blurs the text field (click/tap away) | Timer **resets and restarts** |
| User clicks "Redo" button | Timer **cancelled** (transition to REDO state) |
| User presses PTT button (`mousedown`/`touchstart`) | Timer **cancelled immediately** (PTT recording will begin) |
| Auto-send fires (timer reaches zero) | Timer complete → transition to PROCESSING |

The PTT cancellation is distinct from "Redo" — pressing PTT in REVIEW state transitions directly to RECORDING (a new recording attempt), while "Redo" transitions to the REDO state where the user has both text editing and PTT available. In both cases, the auto-send timer is killed and does not fire.

### REDO Mode-Switch Rules

In the REDO state, both the text field and PTT button are active simultaneously. The following rules govern their interaction within a single response attempt:

**PTT pressed while text field contains edited text:**
1. Any text currently in the field is **discarded** — the PTT recording fully replaces it.
2. The text field is cleared and shows the live STT transcription as it arrives.
3. The resulting `input_mode` is `'voice'`.
4. Rationale: the user's intent when pressing PTT is clearly to re-record, not to append audio to typed text.

**PTT pressed while text field is empty:**
1. Normal recording flow begins. `input_mode` is `'voice'`.

**User types text after a PTT recording was already made in this REDO attempt:**
1. This scenario cannot occur in a single attempt — PTT release sends the user to REVIEW, ending the REDO input phase. A new REDO would start a fresh attempt.

**User edits the STT transcript in the text field (from a prior voice attempt or the original recording):**
1. If the user modifies the text and submits via Enter/Send (without pressing PTT), the `input_mode` is `'edited'`.
2. No audio Blob exists for this submission — the edited text stands alone. Audio fields are null.

**User types entirely new text from scratch (text field was empty or fully cleared):**
1. If submitted via Enter/Send, the `input_mode` is `'text'`.
2. No audio Blob exists. Audio fields are null.

**Determining `input_mode` summary:**

| Action | `input_mode` | Audio Blob? |
|---|---|---|
| PTT record → release | `'voice'` | Yes |
| Edit existing STT transcript → Enter/Send | `'edited'` | No |
| Type from scratch → Enter/Send | `'text'` | No |

---

## 4. Message Sequence — Complete Turn Cycle

This section defines the exact sequence of events for one question-response turn, starting from the LLM's question being displayed through to the next question appearing.

### 4.1 Turn via Push-to-Talk (Voice)

```
Frontend                    Backend (Fargate)              ElevenLabs STT        Claude API         ElevenLabs TTS
   │                              │                              │                    │                    │
   │  [State: AWAITING_INPUT]     │                              │                    │                    │
   │  LLM question visible.       │                              │                    │                    │
   │  User presses PTT button.    │                              │                    │                    │
   │                              │                              │                    │                    │
   │  [State: RECORDING]          │                              │                    │                    │
   │  MediaRecorder.start()       │                              │                    │                    │
   │  Audio buffered locally      │                              │                    │                    │
   │  from first sample.          │                              │                    │                    │
   ├─── WS: connect ─────────────►│                              │                    │                    │
   │    ?token=JWT                 │  Validate JWT.               │                    │                    │
   │    &interviewId=uuid          │  Verify interview belongs    │                    │                    │
   │                              │  to authenticated user.      │                    │                    │
   │                              │  Reject if invalid.          │                    │                    │
   │◄── WS: connection accepted ──┤                              │                    │                    │
   ├─── WS: audio_start ─────────►│                              │                    │                    │
   │                              ├─── WS: open STT session ────►│                    │                    │
   │                              │    (incl. begin_stream msg)   │                    │                    │
   │                              │◄── WS: session_ready ────────┤                    │                    │
   │  [Flush buffered audio       │                              │                    │                    │
   │   chunks to WS, then         │  [Fargate proxy receives     │                    │                    │
   │   stream live]               │   burst, meters relay at     │                    │                    │
   │                              │   ≤1.5× real-time until      │                    │                    │
   │                              │   buffer drained, then       │                    │                    │
   │                              │   pass-through mode]         │                    │                    │
   │                              │                              │                    │                    │
   ├─── WS: audio_chunk ─────────►├─── WS: audio_chunk ─────────►│                    │                    │
   │  [audio also captured by     │    (flow-controlled)          │                    │                    │
   │   MediaRecorder locally]     │◄── WS: partial_transcript ───┤                    │                    │
   │◄── WS: partial_transcript ──┤                              │                    │                    │
   │  [live text appears on       │                              │                    │                    │
   │   screen progressively]      │                              │                    │                    │
   │         ... (repeat) ...     │                              │                    │                    │
   │                              │                              │                    │                    │
   │  User releases PTT button.   │                              │                    │                    │
   │  MediaRecorder.stop()        │                              │                    │                    │
   │  → Audio Blob captured       │                              │                    │                    │
   ├─── WS: audio_end ──────────►├─── WS: close STT session ───►│                    │                    │
   │                              │◄── WS: final_transcript ─────┤                    │                    │
   │◄── WS: final_transcript ────┤                              │                    │                    │
   │◄── WS: connection closed ───┤                              │                    │                    │
   │                              │                              │                    │                    │
   │  [State: REVIEW]             │                              │                    │                    │
   │  Final transcript shown.     │                              │                    │                    │
   │  Audio Blob held in memory.  │                              │                    │                    │
   │  "Redo" button visible.      │                              │                    │                    │
   │  Auto-send timer starts      │                              │                    │                    │
   │  AFTER final_transcript is   │                              │                    │                    │
   │  received and rendered in    │                              │                    │                    │
   │  the text field (~2 sec).    │                              │                    │                    │
   │  Timer PAUSES if user        │                              │                    │                    │
   │  focuses the text field      │                              │                    │                    │
   │  (indicating transcript      │                              │                    │                    │
   │  editing). Timer RESETS      │                              │                    │                    │
   │  and restarts on blur        │                              │                    │                    │
   │  (user clicks/taps away      │                              │                    │                    │
   │  from the text field).       │                              │                    │                    │
   │  Timer CANCELLED immediately │                              │                    │                    │
   │  on PTT mousedown/touchstart.│                              │                    │                    │
   │                              │                              │                    │                    │
   │  ┌─────────────────────────────────────────────────────────────────────────────┐                    │
   │  │ IF USER CLICKS REDO:                                                        │                    │
   │  │  1. Frontend calls saveDraft mutation (transcript + inputMode)               │                    │
   │  │  2. Backend creates response_drafts record, returns draftId                  │                    │
   │  │  3. Frontend requests presigned URL: requestDraftAudioUploadUrl(draftId)     │                    │
   │  │  4. Frontend queues background upload of current Audio Blob to S3            │                    │
   │  │  5. Frontend clears transcript, returns to AWAITING_INPUT with editable      │                    │
   │  │     text field + PTT button (State: REDO)                                    │                    │
   │  │  6. User can re-record (PTT) or edit text → returns to REVIEW               │                    │
   │  └─────────────────────────────────────────────────────────────────────────────┘                    │
   │                              │                              │                    │                    │
   │  Auto-send fires.            │                              │                    │                    │
   │  [State: PROCESSING]         │                              │                    │                    │
   ├─── GQL: submitResponse ─────►│                              │                    │                    │
   │    {interviewId,              │  1. Write to interview_      │                    │                    │
   │     questionId,               │     responses table          │                    │                    │
   │     questionTextAsAsked,      │  2. Update Redis session     │                    │                    │
   │     rawTranscription,         │     state                    │                    │                    │
   │     sequenceNumber,           │  3. Pass response + trigger  │                    │                    │
   │     isFollowup,               │     definitions to LLM      │                    │                    │
   │     parentResponseId,         │     (LLM evaluates triggers) │                    │                    │
   │     categoryBucket,           │  4. Build per-turn state     │                    │                    │
   │     tagsAtTime,               │     update for LLM           │                    │                    │
   │     inputMode: 'voice'}       │  5. Return responseId        │                    │                    │
   │◄── {responseId} ────────────┤                              │                    │                    │
   │                              │                              │                    │                    │
   │  [Background audio upload    │                              │                    │                    │
   │   begins immediately:]       │                              │                    │                    │
   ├─── GET: requestResponse      │                              │                    │                    │
   │    AudioUploadUrl             │                              │                    │                    │
   │    (interviewId, responseId) │                              │                    │                    │
   │◄── {presignedUrl, s3Key} ───┤                              │                    │                    │
   ├─── PUT: upload Audio Blob    │                              │                    │                    │
   │    to S3 (background)────────────────────────────────────── │──► S3              │                    │
   │                              │                              │                    │                    │
   │  [Meanwhile, LLM turn        │                              │                    │                    │
   │   proceeds in parallel:]     │                              │                    │                    │
   │                              ├─── POST (streaming) ─────────────────────────────►│                    │
   │                              │◄── SSE: token stream ────────────────────────────┤                    │
   │◄── SSE: token stream ───────┤                              │                    │                    │
   │                              │                              │                    │                    │
   │  [State: LLM_STREAMING]      │                              │                    │                    │
   │  Text appears token-by-token │                              │                    │                    │
   │  on screen.                  │                              │                    │                    │
   │                              │                              │                    │                    │
   │  [First complete sentence    │                              │                    │                    │
   │   buffered on frontend]      │                              │                    │                    │
   ├─── REST: TTS request ────────────────────────────────────────────────────────────────────────────────►│
   │◄── Audio chunk ──────────────────────────────────────────────────────────────────────────────────────┤
   │  [Auto-play audio begins]    │                              │                    │                    │
   │  [Continue for each sentence]│                              │                    │                    │
   │                              │                              │                    │                    │
   │  [Background: audio upload   │                              │                    │                    │
   │   completes to S3]           │                              │                    │                    │
   ├─── GQL: confirmAudioUpload  │                              │                    │                    │
   │    (responseId, s3Key,       │  Update interview_responses  │                    │                    │
   │     mimeType, duration)──────►│  audio fields               │                    │                    │
   │                              │                              │                    │                    │
   │◄── SSE: stream_complete ────┤                              │                    │                    │
   │    {nextQuestion,             │                              │                    │                    │
   │     interviewComplete,        │                              │                    │                    │
   │     progressPercent}          │                              │                    │                    │
   │                              │                              │                    │                    │
   │  [If interviewComplete:       │                              │                    │                    │
   │   State → COMPLETING]         │                              │                    │                    │
   │  [Else:                       │                              │                    │                    │
   │   State → AWAITING_INPUT      │                              │                    │                    │
   │   with new question]          │                              │                    │                    │
```

### 4.2 Turn via Text Input

Same as above, but skips the RECORDING and REVIEW states entirely:

1. User types in text field and presses Enter or clicks Send
2. No MediaRecorder involved — no audio Blob exists for this turn
3. Frontend transitions directly to PROCESSING
4. `submitResponse` mutation fires with `inputMode: 'text'` and the typed text as `rawTranscription`
5. No audio upload is queued — audio fields remain null for this response
6. LLM streaming response and TTS playback proceed identically

### 4.3 Skip Flow

1. User clicks "Skip" button (available in AWAITING_INPUT)
2. Frontend calls `skipQuestion` mutation with the current question ID
3. Backend records the skip in `interview_responses` with `is_skipped: true`, no transcription, no audio
4. Backend updates Redis session state (question marked as skipped)
5. Backend calls Claude API to get the next question, informing it the user declined to answer
6. Response streams back via SSE as in a normal turn
7. Frontend transitions through LLM_STREAMING → AWAITING_INPUT

### 4.4 Interview Completion

Completion can be triggered two ways:

**LLM-initiated:** The LLM determines all required questions have been covered. In the SSE stream_complete payload, it sets `interviewComplete: true` and delivers a closing message (e.g., "Thank you — we've covered everything. Is there anything else you'd like to add?"). The frontend shows the closing message with TTS and presents two buttons: "Add something" (returns to AWAITING_INPUT for a freeform response) and "Finish interview" (proceeds to completion).

**User-initiated:** The user clicks "End Interview" at any time (button always visible). Frontend shows a confirmation dialog: "Are you sure? There are X required questions remaining." If confirmed, proceeds to completion.

**Completion sequence:**
1. Frontend transitions to COMPLETING state
2. Frontend calls `completeInterview` mutation
3. Backend persists final interview state to DB
4. Backend flushes Redis session
5. Backend publishes `interview.completed` event to EventBridge (triggers cleaning pipeline)
6. Frontend transitions to UPLOADING state
7. Frontend checks if any audio uploads are still in progress (from background upload queue)
8. If all uploads complete within 60 seconds: transition to COMPLETED
9. If uploads are still pending after 60 seconds: show "Some audio is still uploading in the background" and transition to COMPLETED anyway — the upload queue continues working
10. COMPLETED state shows summary: number of questions answered, estimated processing time for cleaning, link to view responses later

**Key change from v1:** There is no monolithic audio upload at completion. All audio has been uploading progressively throughout the interview. The completion flow only needs to wait for any stragglers.

---

## 5. Data Flow Per Turn

### What Gets Saved Where and When

| Event | Redis | PostgreSQL | S3 |
|---|---|---|---|
| Push-to-talk pressed | STT transcript buffer initialized for this turn | — | — |
| Partial transcript arrives | Transcript buffer appended | — | — |
| Push-to-talk released | Final transcript stored in session. Audio Blob held in frontend memory. | — | — |
| User clicks Redo | Current transcript moved to drafts list in session | `response_drafts` record created | Draft audio Blob uploaded in background |
| Auto-send fires / text submitted | — | `interview_responses` record created with committed text | Committed audio Blob upload queued in background |
| Audio upload completes (background) | — | `interview_responses` audio fields updated via confirmAudioUpload | Audio file written |
| Draft audio upload completes (background) | — | `response_drafts` audio fields updated via confirmDraftAudioUpload | Draft audio file written |
| LLM response streams | Conversation history appended, question tracking updated | — | — |
| Interview completes | Session flushed (deleted) | Interview status → 'completed', timestamps set | Any remaining uploads finish in background |
| Interview paused | Session state snapshot persisted to DB | Interview pause state saved | Pending uploads continue in background |

### Redis Session Structure

```json
{
  "interviewId": "uuid",
  "templateId": "uuid",
  "userId": "uuid",
  "conversationHistory": [
    {"role": "assistant", "content": "Tell me about...", "questionId": "uuid", "sequenceNumber": 1},
    {"role": "user", "content": "Well, I think...", "inputMode": "voice"},
    {"role": "assistant", "content": "That's interesting...", "questionId": "uuid", "sequenceNumber": 2}
  ],
  "questionsAsked": ["uuid-1", "uuid-3"],
  "questionsSkipped": ["uuid-5"],
  "bucketsCovered": {"motivation": 2, "process": 1, "challenge": 0},
  "requiredRemaining": ["uuid-2", "uuid-4", "uuid-6"],
  "optionalRemaining": ["uuid-7", "uuid-8"],
  "triggeredFollowups": [{"triggeredBy": "uuid-1", "suggested": ["uuid-9"]}],
  "currentTranscriptBuffer": "partial text from live STT...",
  "currentDrafts": [],
  "totalExpectedQuestions": 12,
  "questionsCompleted": 3,
  "lastActivityAt": "ISO-8601",
  "idleWarningShown": false
}
```

### Redis Session TTL

All interview sessions in Redis have an explicit TTL to prevent memory exhaustion from abandoned or unusually long sessions.

**Active interviews:** TTL of **4 hours**. The backend refreshes (resets) this TTL on every state-mutating event: `submitResponse`, `skipQuestion`, heartbeat receipt, and idle prompt delivery. Under normal interview flow, the TTL is continuously refreshed and never reached. If the frontend stops all interaction without pausing (e.g., browser crash with no `beforeunload` beacon, heartbeat failure undetected), the session expires after 4 hours and the reconciliation Lambda (Section 17) handles the orphaned interview record.

**Paused interviews:** TTL of **15 minutes** (as already specified in Section 10). If the user resumes within 15 minutes, the warm session is reused. After expiry, resume reconstructs from the DB snapshot.

**Why 4 hours:** The longest realistic interview is approximately 1-2 hours. A 4-hour TTL provides generous headroom for edge cases (long pauses between questions, slow typists, extended voice responses) while ensuring abandoned sessions don't persist indefinitely. The heartbeat-driven refresh means the TTL only matters when all frontend signals have stopped.

---

## 6. Follow-Up Trigger Evaluation

### Decision: LLM Evaluates All Triggers

Follow-up trigger evaluation is performed entirely by the LLM. There are no application-side keyword matchers, sentiment analysis services, or word count functions. The trigger definitions from the template are passed directly into the LLM system prompt, and the LLM uses its judgment to decide whether triggers have been activated.

### Why LLM-Based Evaluation

- **Simpler architecture:** No separate NLP services to build, maintain, or scale. No keyword matching edge cases (plurals, synonyms, negations). No sentiment model selection or tuning.
- **Better judgment:** The LLM understands context, nuance, and conversational meaning. A keyword trigger for "challenge" should fire when someone describes a difficulty even if they never use that exact word. The LLM handles this naturally; a keyword matcher would miss it.
- **Less deterministic but more useful:** A rule-based system would fire on exact keyword matches but miss semantic equivalents. The LLM may occasionally miss a trigger or fire one loosely, but its decisions will generally be more contextually appropriate.
- **Consistent with the overall design:** The entire interview orchestration already trusts the LLM with significant discretion (question reordering, deduplication, conversational adaptation). Trigger evaluation is a natural extension of that trust.

### How Triggers Are Passed to the LLM

The system prompt includes the trigger definitions as structured instructions. For each question in the template, the LLM receives:

```
Question 4 (required): "Describe any challenges your team faces with the current CRM system."
Category bucket: process
Follow-up triggers:
  - If the response mentions challenges with data quality, migration, or integration → suggest follow-up Q11
  - If the response is notably brief (fewer than ~100 words) → suggest follow-up Q12 to probe deeper
  - If the response expresses strong negative sentiment about the system → suggest follow-up Q13
  - Always after this question → suggest follow-up Q14 about workarounds
```

The LLM is instructed: "After each response, evaluate the follow-up triggers listed for that question. If any trigger conditions are met based on your judgment, ask one of the suggested follow-up questions before moving to the next core question. You have discretion — triggers are suggestions, not hard rules."

### What This Means for Implementation

- **No keyword matching service needed.** Delete any placeholder or planned keyword matching code.
- **No sentiment analysis service needed.** No external sentiment model or library.
- **No word/length counting logic needed** (for trigger evaluation). The LLM can judge whether a response is "brief" without an exact word count.
- **The per-turn state update** (Section 5 of interview-spec-v1.md) does NOT pre-evaluate triggers before passing to the LLM. Instead, the raw trigger definitions are included in the system prompt, and the LLM evaluates them against each response in real time.
- **Follow-up tracking** still happens in Redis: when the LLM asks a follow-up, the backend records which trigger was activated and which follow-up was selected. This is for analytics, not for runtime control.

---

## 7. Response Drafts — Silent Redo Tracking

### New Table: `response_drafts`

Every time the user clicks "Redo," the current transcript AND audio are saved as a draft. This is invisible to the end user but critical for debugging STT quality, understanding user behavior, and improving the system.

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| interview_id | UUID | FOREIGN KEY → interviews(id), NOT NULL |
| question_id | UUID | FOREIGN KEY → questions(id) |
| draft_number | INTEGER | NOT NULL (1-indexed, increments per redo) |
| content | TEXT | NOT NULL |
| input_mode | VARCHAR(20) | NOT NULL, CHECK (input_mode IN ('voice', 'text', 'edited')) |
| stt_confidence_score | NUMERIC(5,4) | — |
| s3_audio_key | VARCHAR(1024) | — |
| s3_audio_bucket | VARCHAR(255) | — |
| audio_mime_type | VARCHAR(100) | — |
| audio_duration_seconds | NUMERIC(10,2) | — |
| audio_upload_status | VARCHAR(20) | CHECK (audio_upload_status IN ('pending', 'uploaded', 'failed', 'not_applicable')), DEFAULT 'not_applicable' |
| created_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |

**Constraints:** UNIQUE on (interview_id, question_id, draft_number).

**Notes:**
- `input_mode` values: 'voice' = original STT output, 'text' = user typed from scratch, 'edited' = user manually edited a voice transcription
- Audio fields are null when `input_mode` is 'text' (no recording was made)
- `audio_upload_status` tracks whether the background upload has completed — 'not_applicable' for text-mode drafts (no audio exists), 'pending' for voice drafts until confirmed, 'uploaded' on success, 'failed' after all retries exhausted. Defaults to 'not_applicable'; the backend sets it to 'pending' when `input_mode` is 'voice' or 'edited'.
- The final committed response is NOT stored here — it goes into `interview_responses` as before
- Drafts are write-only from the user's perspective; only accessible to administrators and the debugging/analytics pipeline
- `draft_number` starts at 1 for the first attempt that was redone, 2 for the second, etc.

### Adding Columns to `interview_responses`

New columns on the existing `interview_responses` table:

| Column | Type | Constraints |
|---|---|---|
| input_mode | VARCHAR(20) | NOT NULL DEFAULT 'voice', CHECK (input_mode IN ('voice', 'text', 'edited')) |
| audio_upload_status | VARCHAR(20) | NOT NULL DEFAULT 'not_applicable', CHECK (audio_upload_status IN ('pending', 'uploaded', 'failed', 'not_applicable')) |
| is_skipped | BOOLEAN | NOT NULL DEFAULT FALSE |

**Notes:**
- `input_mode` tracks how the final committed response was created
- `audio_upload_status` tracks background upload progress. Set to 'pending' when a voice response is submitted, 'uploaded' when `confirmAudioUpload` is called, 'failed' after retries exhausted, 'not_applicable' for text responses and skips
- `is_skipped` marks responses where the user explicitly skipped the question (no transcription, no audio)
- Existing audio fields (`s3_audio_key`, `s3_audio_bucket`, `audio_mime_type`, `audio_duration_seconds`) remain as-is from interview-spec-v1.md but are now populated progressively during the interview rather than post-completion

---

## 8. User-to-Template Assignment Model

### Decision: Simple FK on `users` + Assignment History Table

The `user_templates` junction table from interview-spec-v1.md is **removed**. It was overengineered for a one-to-one relationship and would cause Claude Code to implement many-to-many behavior.

### Schema Changes

**Modified `users` table — add columns:**

| Column | Type | Constraints |
|---|---|---|
| current_template_id | UUID | FOREIGN KEY → interview_templates(id), NULLABLE |
| template_assigned_at | TIMESTAMP WITH TIME ZONE | — |
| template_assigned_by | UUID | FOREIGN KEY → users(id) |

**Notes:**
- `current_template_id` is nullable — a user with no template assigned simply has null here
- The FK constraint enforces that only existing templates can be assigned
- Only templates with status 'published' should be assignable — enforced at the application layer, not the FK constraint (since a template could be archived after assignment)
- The `UNIQUE` constraint is implicit — a column on the `users` table can only hold one value

**New table: `template_assignment_history`**

| Column | Type | Constraints |
|---|---|---|
| id | UUID | PRIMARY KEY |
| user_id | UUID | FOREIGN KEY → users(id), NOT NULL |
| template_id | UUID | FOREIGN KEY → interview_templates(id), NOT NULL |
| assigned_at | TIMESTAMP WITH TIME ZONE | NOT NULL DEFAULT NOW |
| assigned_by | UUID | FOREIGN KEY → users(id) |
| unassigned_at | TIMESTAMP WITH TIME ZONE | — |
| unassigned_reason | VARCHAR(100) | — |

**Notes:**
- Every assignment and reassignment creates a row in this table
- When a user is reassigned from template A to template B: the template A row gets `unassigned_at` set and `unassigned_reason` set to 'reassigned', and a new row is created for template B
- `unassigned_reason` values: 'reassigned', 'template_archived', 'admin_removed'
- This table is append-mostly — rows are updated only to set `unassigned_at` when a reassignment happens

### Reassignment Workflow

1. Admin calls `assignTemplateToUser(userId, templateId)`
2. Backend checks: is there a current assignment?
   - If yes: update the existing `template_assignment_history` row with `unassigned_at = NOW()` and `unassigned_reason = 'reassigned'`
   - Create new `template_assignment_history` row for the new assignment
   - Update `users.current_template_id`, `users.template_assigned_at`, `users.template_assigned_by`
3. If no current assignment: create new history row and set the FK

### Interview History Access

**Users can always view past interviews regardless of current template assignment.** The `interviews` table has its own `template_id` FK that records which template was used for each interview. This is independent of the user's current assignment. Interview history queries join on `interviews.user_id`, not on the current template assignment.

### What This Replaces in interview-spec-v1.md

- The `user_templates` table definition in Section 4 is **removed entirely**
- The `assignTemplateToUser` mutation behavior changes (now updates FK on users + writes history)
- The `getUser` query response changes: `assignedTemplate` resolves from `users.current_template_id` instead of joining through `user_templates`
- All references to `user_templates` throughout the spec should be updated to reference `users.current_template_id`

---

## 9. Soft-Delete Policy for Tags and Questions

### Decision: Never Hard-Delete. Deactivate Instead.

Tags and questions are **never hard-deleted** from the database. This is consistent with the existing "never delete templates, archive them" policy. The principle: master data referenced by historical records must not be destroyed.

### Schema Changes

**Add to `tags` table:**

| Column | Type | Constraints |
|---|---|---|
| is_active | BOOLEAN | NOT NULL DEFAULT TRUE |

**Add to `questions` table:**

| Column | Type | Constraints |
|---|---|---|
| is_active | BOOLEAN | NOT NULL DEFAULT TRUE |

### Deactivation Behavior

**Tags:**
- Deactivating a tag sets `is_active = false`
- Deactivated tags are excluded from all selection dropdowns and filter UIs in the admin interface
- Existing associations (`question_tags`, `user_tags`) are **not deleted** — they remain intact for historical accuracy
- Queries that return tags for display (e.g., on a question detail view) still show deactivated tags but with a visual indicator (e.g., strikethrough or "inactive" badge)
- The tag management admin page shows all tags with a toggle for active/inactive, and a filter to show/hide inactive tags
- If an admin tries to deactivate a tag that is actively used in a published template's questions, show a warning (not a block): "This tag is used by X questions in Y published templates. Deactivating it will not affect existing templates but will prevent it from being used in new ones."

**Questions:**
- Deactivating a question sets `is_active = false`
- Deactivated questions are excluded from the question bank selection UI when building new templates
- Questions already included in existing templates (via `template_questions`) are **not removed** — the template retains them
- If an admin deactivates a question that is in a published template, show a warning: "This question is included in X published templates. It will remain in those templates but will not appear in the question bank for new templates."
- Interview response records that reference a deactivated question retain their `question_id` FK — historical data is unaffected

### GraphQL Changes

**Modified mutations:**
- `updateTag(id, label, tagType, isActive)` — `isActive` parameter added; this is how deactivation happens
- `updateQuestion(id, text, category, tagIds, isActive)` — `isActive` parameter added

**Modified queries:**
- `getTags(tagType, includeInactive)` — new `includeInactive` boolean parameter, defaults to false. Admin UI passes `true`; template builder passes `false`.
- `getQuestions(filters, includeInactive)` — same pattern

**No new delete mutations.** Claude Code must not create `deleteTag` or `deleteQuestion` mutations. If it does, this is a spec violation.

---

## 10. Pause and Resume Protocol

### Pause Flow

1. User clicks "Pause" (available whenever state is AWAITING_INPUT)
2. Frontend calls `pauseInterview` mutation
3. Backend snapshots Redis session state to the `session_snapshot` JSONB column on the `interviews` table
4. Backend sets interview status to 'paused' with a `paused_at` timestamp
5. Backend does NOT flush Redis immediately — keeps the session alive for 15 minutes in case the user resumes quickly
6. If Redis session expires naturally (TTL), resume reconstructs from DB snapshot
7. Frontend shows paused screen with "Resume" button
8. Any pending audio uploads in the background continue — they are not interrupted by pause

### New Columns on `interviews` Table

| Column | Type | Constraints |
|---|---|---|
| session_snapshot | JSONB | — |
| paused_at | TIMESTAMP WITH TIME ZONE | — |

### Resume Flow

1. User clicks "Resume" (or navigates back to an in_progress interview)
2. Frontend calls `resumeInterview` mutation
3. Backend checks Redis for existing session:
   - If found: session is still warm, proceed directly
   - If not found: reconstruct from `session_snapshot` JSONB + any `interview_responses` written since the snapshot (belt and suspenders)
4. Backend rebuilds LLM conversation context from stored conversation history
5. Backend calls Claude API with full context + instruction: "The interviewee paused and has now returned. Continue the interview naturally from where you left off."
6. LLM response streams back with a welcoming re-engagement message and the next question
7. Frontend transitions to AWAITING_INPUT

---

## 11. Inactivity Handling

### Idle Timer

The idle timer runs on the **backend**, not the frontend, to prevent browser tab suspension from causing false positives.

1. After each LLM response is delivered (stream_complete), the backend sets `lastActivityAt` in Redis
2. A background process (or the next heartbeat check) compares current time to `lastActivityAt`
3. At **60 seconds** of inactivity:
   - Backend triggers an LLM call with instruction: "The interviewee has been quiet for a minute. Generate a brief, warm prompt to re-engage them. You may offer to rephrase the current question."
   - Response streams to frontend via SSE (the frontend maintains a long-lived SSE connection for push notifications during AWAITING_INPUT)
   - TTS auto-plays the prompt
   - Redis flag `idleWarningShown` set to true
   - The idle prompt is **appended to `conversationHistory` in Redis** as an assistant message with a `"type": "idle_prompt"` marker (e.g., `{"role": "assistant", "content": "Take your time...", "type": "idle_prompt"}`). This ensures the LLM has context of its own prior re-engagement message on the next turn and does not repeat itself or contradict what it just said.
4. At **3 minutes** of inactivity (cumulative, after the warning):
   - Backend calls `pauseInterview` automatically
   - Frontend receives a push notification via SSE: `{type: 'auto_paused'}`
   - Frontend transitions to PAUSED state with message: "Your interview has been paused. Click Resume when you're ready to continue."

### Heartbeat

The frontend sends a lightweight heartbeat to the backend every 30 seconds while in AWAITING_INPUT state. This serves two purposes:
- Confirms the browser tab is still active
- If the backend stops receiving heartbeats, it knows the user may have closed the tab (distinct from being idle but present)

If heartbeats stop for 5 minutes, the backend auto-pauses the interview (same as inactivity auto-pause).

---

## 12. Security Considerations

### WebSocket Authentication

The STT WebSocket carries live audio from a specific user's interview session. It must be authenticated and scoped to the correct interview.

**Authentication protocol:**
1. Frontend connects to the STT WebSocket with the Cognito JWT and interview ID as query parameters:
   ```
   wss://api.example.com/stt?token=<JWT>&interviewId=<UUID>
   ```
2. Backend validates the JWT on the WebSocket upgrade request (before accepting the connection):
   - Verify JWT signature against Cognito JWKS
   - Verify JWT is not expired
   - Extract user ID (sub claim) from JWT
3. Backend cross-references the interview:
   - Fetch the interview record for the provided `interviewId`
   - Verify `interview.user_id` matches the authenticated user's ID
   - Verify `interview.status` is 'in_progress'
4. If any validation fails: reject the WebSocket upgrade with HTTP 401 (invalid/expired JWT) or 403 (interview doesn't belong to this user)
5. If validation passes: accept the WebSocket connection. The connection is now implicitly scoped to this user and this interview for its entire lifetime.

**Connection lifecycle:**
- The WebSocket opens when PTT is pressed and closes when PTT is released (per the STT channel lifecycle in Section 1)
- A new WebSocket connection is established for each PTT press — each connection goes through the auth flow
- JWT expiration during a recording: if the JWT expires mid-recording, the current WebSocket session remains valid (it was authenticated at connection time). The next PTT press will fail to connect if the JWT has not been refreshed.
- Frontend should proactively refresh the Cognito JWT before it expires (standard Amplify SDK behavior)

### SSE Endpoint Authentication

The SSE endpoint (`GET /api/interview/:id/stream`) also requires authentication:
1. Cognito JWT passed as a Bearer token in the Authorization header
2. Backend validates JWT and verifies interview ownership (same checks as WebSocket)
3. If invalid: return HTTP 401/403 before establishing the SSE stream

### TTS API Key Exposure

The TTS calls are made from the frontend directly to ElevenLabs. This means the frontend needs access to the ElevenLabs API key — which cannot be embedded in client-side code.

**Solution: Short-lived token endpoint**

1. Backend exposes a REST endpoint: `GET /api/tts-token`
2. Requires valid Cognito JWT
3. Returns a short-lived ElevenLabs API key or scoped token (depending on ElevenLabs' API capabilities)
4. Token valid for the duration of the interview session (or refreshed periodically)
5. Frontend stores the token in memory (never localStorage) and includes it in TTS API calls

**Alternative (if ElevenLabs doesn't support scoped tokens):** Proxy TTS through the backend. This adds latency but avoids exposing the API key. Acceptable fallback — measure the latency impact and decide during implementation.

### Presigned URL Security

All S3 audio uploads use presigned URLs generated by the backend. These URLs:
- Are scoped to a specific S3 key (the response or draft's designated path)
- Expire after 15 minutes (sufficient for upload even on slow connections)
- Require the frontend to have already authenticated via Cognito JWT to obtain the URL
- Do not grant any read access — they are PUT-only

### Audio Data in Transit

- STT audio streams over WSS (WebSocket Secure) to Fargate, then to ElevenLabs
- Audio uploads to S3 use HTTPS via presigned URLs
- TTS audio returned over HTTPS from ElevenLabs to the frontend
- No unencrypted audio transmission at any point

### Draft Data Sensitivity

Response drafts may contain sensitive information (especially in the M&A interview context). They inherit the same access control as interview responses: only administrators and the interviewee can access them. The `response_drafts` table should respect the same row-level access patterns as `interview_responses`.

---

## 13. Interview UI Layout Specification

### Platform Target

The interview UI targets **desktop browsers only in v1**. The layout, interaction patterns (particularly push-to-talk hold behavior), and component sizing are designed for mouse/keyboard input on viewports ≥ 1024px wide. Mobile and tablet support is deferred to a future version — push-to-talk on mobile conflicts with OS-level long-press gestures, and the simultaneous text field + PTT layout requires responsive redesign. The frontend should not actively block mobile browsers but is not required to provide a usable experience on them. A "For the best experience, please use a desktop browser" notice is sufficient for mobile visitors.

### Visual Structure

The interview screen uses a **hybrid layout**: the current question is focused at the top, with a scrollable transcript building below.

```
┌─────────────────────────────────────────────────────────────┐
│  [Logo]                          [Progress Bar]  [Pause] [End] │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│   ┌───────────────────────────────────────────────────────┐   │
│   │  CURRENT QUESTION (focused, prominent)                 │   │
│   │                                                         │   │
│   │  "Tell me about your experience with the current       │   │
│   │   CRM system and any pain points your team faces."     │   │
│   │                                                         │   │
│   │                                    [Skip]              │   │
│   └───────────────────────────────────────────────────────┘   │
│                                                               │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│                                                               │
│   TRANSCRIPT (scrollable, grows downward)                     │
│                                                               │
│   Q1: What initially attracted you to this company?           │
│   A1: I was drawn to the mission and the team culture...      │
│                                                               │
│   Q2: How has the acquisition announcement affected...        │
│   A2: There's been some uncertainty, especially around...     │
│                                                               │
│   Q3: [Current — answer appearing live as user speaks]        │
│   A3: The CRM has been a sore spot for us because ████       │
│        [live transcription cursor]                            │
│                                                               │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────────────────────────┐  ┌────────────────────┐ │
│  │  Type your response...           │  │ 🎤 Hold to talk   │ │
│  └─────────────────────────────────┘  └────────────────────┘ │
│                                                               │
│  [Redo]  (visible only in REVIEW state)                      │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Component Details

**Current Question Panel:**
- Always visible at the top, not scrollable
- Uses `--dark-maroon` background with `--ivory` text (per brand standards chat widget pattern)
- Question text uses IBM Plex Sans, weight 400, 18px
- Skip button: subtle, right-aligned, `--grey` text, only visible for non-required questions (required questions hide the skip button)
- During LLM_STREAMING state: text appears token-by-token in this panel with a typing indicator

**Progress Bar:**
- Thin horizontal bar below the header
- `--horizon-red` fill on `--ivory-tint` background
- No numbers, no labels — purely visual
- Width calculated as: `questionsCompleted / totalExpectedQuestions * 100%`
- Animates smoothly on each question completion

**Transcript Area:**
- Scrollable area between the question panel and input area
- Auto-scrolls to bottom as new content appears
- Questions in `--graphite` bold, answers in `--graphite` regular weight
- During RECORDING: live transcription appears character-by-character with a blinking cursor
- Previous Q&A pairs are readable but de-emphasized (slightly reduced opacity)

**Input Area:**
- Text input field: `--ivory-tint` background, full width minus push-to-talk button
- Push-to-talk button: pill shape, `--horizon-red` background, `--white` icon/text
- During RECORDING: PTT button pulses or shows a recording indicator (waveform animation)
- During REVIEW: "Redo" button appears below the input area as a text link in `--grey`
- During MEDIA_ERROR: PTT button is visually disabled (grayed out, `--grey` background, no hover effect). A "Retry Microphone" text link appears adjacent to the PTT button. The text input field remains fully active and styled normally.
- Text input accepts Enter to submit (or a Send button for mobile)

**Header Controls:**
- Pause button: icon button, always visible
- End Interview button: text button, `--grey`, always visible
- Both require confirmation dialogs before executing

### Brand Standard Application

All UI elements follow `brandStandards.md`. Key mappings for the interview screen:
- Chat-like panels use `--dark-maroon` background (per chat widget spec)
- Input fields use `--ivory-tint` background
- Primary actions (PTT button, Send) use `--horizon-red`
- Body text: IBM Plex Sans 400, 16-18px
- The interview screen does NOT use Space Grotesk (that's hero/campaign only)

---

## 14. SSE Stream Message Types

The backend-to-frontend SSE connection carries structured JSON messages. The frontend must handle each type.

### During LLM Response Streaming

```json
{"type": "token", "content": "Tell"}
{"type": "token", "content": " me"}
{"type": "token", "content": " about"}
...
{"type": "sentence_complete", "sentence": "Tell me about your experience with the CRM.", "sentenceIndex": 0}
...
{"type": "stream_complete", "fullResponse": "Tell me about your experience with the CRM. What pain points has your team encountered?", "questionId": "uuid", "sequenceNumber": 4, "isFollowup": false, "interviewComplete": false, "progressPercent": 33}
```

### During Idle Prompts

```json
{"type": "idle_prompt", "content": "Take your time — would you like me to rephrase that question?", "questionId": null}
```

### During Auto-Pause

```json
{"type": "auto_paused", "reason": "inactivity", "resumeAvailable": true}
```

### During Interview Completion (LLM-initiated)

```json
{"type": "stream_complete", "fullResponse": "Thank you for sharing all of that...", "questionId": null, "interviewComplete": true, "progressPercent": 100, "closingMessage": true}
```

### Sentence Boundary Detection Algorithm

The backend must detect sentence boundaries in the LLM token stream to emit `sentence_complete` events. Naive splitting on periods breaks on abbreviations (e.g., "Dr. Smith"), decimals (e.g., "3.5 million"), ellipses ("and then..."), and URLs. The backend uses a regex-with-exclusions approach:

**Algorithm:**
1. As tokens arrive, the backend appends them to a sentence buffer.
2. After each token, the backend tests the buffer against a sentence-terminating regex that matches a sentence-ending punctuation mark (`.`, `?`, `!`) followed by one or more whitespace characters or end-of-stream, but only when the punctuation is NOT preceded by a known abbreviation or numeric pattern.
3. The exclusion list covers common abbreviations: `Mr`, `Mrs`, `Ms`, `Dr`, `Prof`, `Sr`, `Jr`, `Inc`, `Ltd`, `Corp`, `vs`, `etc`, `approx`, `dept`, `est`, `govt`, `e.g`, `i.e`, `St`, `Ave`, `Blvd`. This list is maintained as a configurable constant, not hardcoded inline.
4. Numeric decimals are excluded: a period preceded by a digit and followed by a digit (e.g., `3.5`) is never treated as a sentence boundary.
5. Ellipses (`...` or `…`) are excluded: three or more consecutive periods, or the Unicode ellipsis character, are never treated as a sentence boundary.
6. When a valid sentence boundary is detected, the backend emits a `sentence_complete` event with the accumulated sentence text, resets the buffer, and increments `sentenceIndex`.
7. When the LLM stream ends (`stream_complete`), any remaining text in the buffer is emitted as a final `sentence_complete` event before the `stream_complete` event.

**Reference regex (JavaScript):**
```javascript
// Negative lookbehind for abbreviations and decimals; 
// positive lookahead for whitespace or end-of-string
const ABBREVIATIONS = 'Mr|Mrs|Ms|Dr|Prof|Sr|Jr|Inc|Ltd|Corp|vs|etc|approx|dept|est|govt|e\\.g|i\\.e|St|Ave|Blvd';
const SENTENCE_END = new RegExp(
  `(?<!\\b(?:${ABBREVIATIONS}))` +  // not preceded by abbreviation
  `(?<!\\d)` +                        // not preceded by digit (decimal guard)
  `(?<!\\.\\.)` +                     // not preceded by ".." (ellipsis guard)
  `[.?!]` +                           // sentence-ending punctuation
  `(?:\\s|$)`,                         // followed by whitespace or end
  'u'
);
```

**Edge cases and fallbacks:**
- If the LLM produces an unusually long run of tokens without a detected sentence boundary (over 500 characters), the backend emits a `sentence_complete` at the next clause boundary (comma, semicolon, em-dash, or colon followed by a space). This prevents TTS from waiting indefinitely for a first sentence on long single-sentence responses.
- The abbreviation list may need tuning based on observed LLM output. Log cases where the 500-character fallback fires — these may indicate missing abbreviations or unusual punctuation patterns.

### TTS Triggering Rule

The frontend buffers incoming tokens. When a `sentence_complete` message arrives, the frontend immediately sends that sentence to the ElevenLabs TTS API and queues the audio for playback. Audio begins playing as soon as the first sentence is synthesized — subsequent sentences queue behind it. This means the user hears the bot's voice while the remaining text is still streaming in.

### SSE Connection Lifecycle

The SSE connection is **long-lived** — it opens once at interview start and persists across all turns until the interview ends or is paused.

**Opening:** The frontend opens the SSE connection (`GET /api/interview/:id/stream`) immediately after `startInterview` returns successfully (during the transition from STARTING to AWAITING_INPUT). This single connection is used for all subsequent LLM response streaming, idle prompts, and auto-pause notifications.

**Persistence across turns:** The SSE connection does NOT close between turns. After a `stream_complete` event, the connection remains open in a quiet state. The backend pushes `idle_prompt` and `auto_paused` events on the same connection. The frontend does not need to re-establish the connection for each `submitResponse` call — the backend routes the LLM stream for the current turn to the existing SSE connection identified by the interview ID.

**Closing:** The SSE connection closes when:
- The interview completes (`completeInterview` mutation fires — backend sends a final `stream_complete` with `interviewComplete: true` and then closes the connection)
- The interview is paused (backend sends `auto_paused` or processes `pauseInterview`, then closes the connection)
- The frontend navigates away or the browser tab closes

**Reconnection strategy:**
1. If the SSE connection drops unexpectedly (network blip, backend restart), the frontend detects the `EventSource` `onerror` event.
2. Frontend waits 1 second, then attempts to reconnect by opening a new SSE connection to the same endpoint with the same JWT.
3. On reconnection, the backend checks the interview's current state in Redis. If an LLM response was mid-stream when the connection dropped, the backend re-streams the full current response from the beginning (not a partial resume — LLM responses are short enough that replaying is simpler and safer than tracking byte offsets).
4. If reconnection fails after 3 attempts (1s, 2s, 4s exponential backoff), the frontend transitions to the ERROR state with a retry option.
5. The backend does NOT auto-pause on SSE disconnection alone — it relies on the heartbeat timeout (5 minutes) for that determination. A brief SSE drop during an active session is recoverable.

**Resume after pause:** When `resumeInterview` is called, the frontend opens a fresh SSE connection as part of the resume flow. The backend streams the LLM's re-engagement message on this new connection.

---

## 15. Error Handling and Recovery

### STT WebSocket Drops During Recording

1. Frontend detects WebSocket close/error during RECORDING state
2. Frontend immediately stops the MediaRecorder — the partial audio Blob is captured
3. Frontend saves whatever partial transcript was received
4. Frontend transitions to REVIEW state with the partial transcript + a warning: "Connection interrupted — your response may be incomplete. You can redo to try again."
5. The partial audio Blob is retained — if the user accepts the partial response (auto-send fires), the partial audio still uploads to S3
6. If the user redoes, the partial audio uploads as a draft

### STT WebSocket Authentication Failure

1. Frontend attempts to open WebSocket with JWT and interviewId
2. Backend rejects the upgrade (HTTP 401 or 403)
3. Frontend shows error: "Unable to connect to the recording service. Please try again."
4. If JWT expired: frontend refreshes the Cognito token automatically (Amplify SDK) and retries
5. If interview ownership check fails: this indicates a bug — log the error and show a generic error message

### LLM API Error During Streaming

1. Backend detects Claude API error during streaming
2. Backend sends SSE error message: `{"type": "error", "message": "I'm having trouble generating a response. Let me try again.", "retryable": true}`
3. Frontend shows error state with "Retry" button
4. On retry: backend resends the same prompt to Claude API
5. After 3 failed retries: frontend shows "We're experiencing technical difficulties. Your interview has been saved — you can resume later." and auto-pauses

### TTS Failure

1. TTS is non-critical — the text response is already visible on screen
2. If TTS API call fails: frontend logs the error, continues without audio
3. No user-visible error state for TTS failures — the experience degrades gracefully to text-only

### Audio Upload Failure

1. Background audio upload fails (network error, S3 error, presigned URL expired)
2. Frontend retries up to 3 times with exponential backoff (1s, 2s, 4s)
3. If presigned URL expired: request a new one and retry
4. If all retries fail: set `audio_upload_status` to 'failed' via mutation, log the error
5. The interview continues uninterrupted — upload failure is non-blocking
6. A reconciliation job (see Section 17) periodically scans for failed uploads and can re-attempt them if the audio Blob was persisted (future consideration: IndexedDB fallback for Blob persistence)

### Browser Tab Close / Navigation Away

1. Frontend registers a `beforeunload` handler
2. On unload: sends a best-effort `pauseInterview` mutation (using `navigator.sendBeacon` or equivalent)
3. If the beacon fails: the backend's heartbeat timeout (5 minutes) will auto-pause the interview
4. Interview data is safe — all committed responses are already in PostgreSQL
5. Audio Blobs still in memory (not yet uploaded) are lost — but their transcriptions are already persisted. The response will have `audio_upload_status: 'pending'` with no actual S3 file. The reconciliation job flags these for admin review.

### Network Disconnection (General)

1. Frontend detects offline state via `navigator.onLine` or failed heartbeat
2. Shows banner: "You appear to be offline. Your interview will resume when your connection returns."
3. Audio uploads in the background queue are paused (not abandoned)
4. On reconnection: frontend calls `resumeInterview` to re-establish the session
5. Background audio upload queue resumes automatically
6. Any in-progress recording is discarded (user will need to re-answer the current question)

---

## 16. New and Modified GraphQL Operations

This section lists all GraphQL changes required by this protocol that are not already in interview-spec-v1.md Section 7.

### New Mutations

- `saveDraft(interviewId, questionId, content, inputMode, sttConfidenceScore)` — saves a redo draft silently; returns `draftId`
- `skipQuestion(interviewId, questionId)` — records a skip, returns next LLM question via SSE
- `pauseInterview(interviewId)` — snapshots state, pauses interview
- `resumeInterview(interviewId)` — reconstructs state, returns next LLM question via SSE
- `requestResponseAudioUploadUrl(interviewId, responseId)` — returns presigned S3 PUT URL for a committed response's audio segment
- `requestDraftAudioUploadUrl(interviewId, draftId)` — returns presigned S3 PUT URL for a draft's audio segment
- `confirmAudioUpload(responseId, s3Key, mimeType, durationSeconds)` — called after successful background upload; updates audio fields on `interview_responses`
- `confirmDraftAudioUpload(draftId, s3Key, mimeType, durationSeconds)` — called after successful draft audio upload; updates audio fields on `response_drafts`

### Modified Mutations

- `submitResponse` — add `inputMode` parameter (VARCHAR, one of: 'voice', 'text', 'edited'); returns `responseId` (needed for audio upload URL request)
- `startInterview` — returns first LLM question via SSE stream (not just template metadata)
- `assignTemplateToUser(userId, templateId)` — now updates `users.current_template_id` FK + writes to `template_assignment_history` (replaces junction table insert)
- `updateTag(id, label, tagType, isActive)` — `isActive` parameter added for soft-delete
- `updateQuestion(id, text, category, tagIds, isActive)` — `isActive` parameter added for soft-delete
- `getTags(tagType, includeInactive)` — new `includeInactive` parameter, defaults to false
- `getQuestions(filters, includeInactive)` — new `includeInactive` parameter, defaults to false

### Replaced Mutations

- `requestAudioUploadUrl(interviewId)` from interview-spec-v1.md is **removed**. Replaced by per-response `requestResponseAudioUploadUrl` and per-draft `requestDraftAudioUploadUrl`.

### Removed Tables

- `user_templates` junction table is **removed**. Replaced by `users.current_template_id` FK + `template_assignment_history` table.

### Explicitly Prohibited Mutations

The following mutations must NOT be implemented. Claude Code must not create them:
- `deleteTag` — use `updateTag` with `isActive: false` instead
- `deleteQuestion` — use `updateQuestion` with `isActive: false` instead
- `deleteTemplate` — use `updateTemplate` with `status: 'archived'` instead (already established in interview-spec-v1.md)

### New REST Endpoints

- `GET /api/tts-token` — returns short-lived ElevenLabs TTS token (requires Cognito JWT)
- `GET /api/interview/:id/stream` — SSE endpoint for receiving LLM responses, idle prompts, and auto-pause notifications during an active interview (requires Cognito JWT via Authorization header)

### New Queries (Admin)

- `getDraftsForResponse(interviewId, questionId)` — returns all drafts for a question, including audio references and upload status
- `getTemplateAssignmentHistory(userId)` — returns full assignment history for a user

---

## 17. Reconciliation and Background Jobs

### Consolidated Reconciliation Lambda

All reconciliation tasks run in a **single Lambda function** triggered by an **EventBridge scheduled rule** (every 15 minutes). This Lambda is defined in the Compute Stack CDK (see Section 19: Implementation Task Mapping). It performs three scan types in sequence:

**Scan 1: Stuck Cleaning States**
- Query: `interview_responses` where `processing_status = 'cleaning'` and `responded_at` is older than 10 minutes
- Action: Reset `processing_status` to 'pending' so the cleaning pipeline retries
- This reconciliation was already described in interview-spec-v1.md Section 5 but had no defined infrastructure. It now has a home.

**Scan 2: Audio Upload Inconsistencies**
- Query A: `interview_responses` where `input_mode = 'voice'` and `audio_upload_status = 'pending'` and `responded_at` is older than 1 hour. These represent responses where the browser may have uploaded audio but never confirmed, or where the upload silently failed.
- Query B: `interview_responses` and `response_drafts` where `audio_upload_status = 'failed'`.
- Action: Flag for admin review dashboard. No automatic re-upload since the audio Blob only existed in browser memory.
- Query C: Orphaned S3 objects in the interview audio prefix that don't correspond to any database record. Action: tag for lifecycle cleanup (don't delete immediately in case of race conditions).

**Scan 3: Paused Interview Auto-Abandonment**
- Query: `interviews` where `status = 'paused'` and `paused_at` is older than 72 hours
- Action: Set `status = 'abandoned'`. Fire `interview.abandoned` EventBridge event (could trigger admin notification).

### CDK Definition

The reconciliation Lambda is defined in the Compute Stack with:
- Runtime: Node.js 20
- Timeout: 5 minutes (sufficient for all three scans)
- Environment variables: DATABASE_URL from Secrets Manager
- IAM role: read/write RDS, list S3 objects in the interview audio prefix
- EventBridge scheduled rule: `rate(15 minutes)`
- No SQS trigger — this is a cron-style job, not an event-driven one

### Cleaning Pipeline Trigger

The cleaning pipeline trigger is unchanged from v1 — it fires on `interview.completed` EventBridge event. The cleaning pipeline processes `raw_transcription` text, not audio. Audio upload status is irrelevant to cleaning.

---

## 18. Modifications to interview-spec-v1.md

This protocol document introduces changes that should be reflected back in the main spec. Listed here for traceability.

### Data Model Additions
1. New table: `response_drafts` (Section 7 of this document) — includes audio fields
2. New table: `template_assignment_history` (Section 8 of this document)
3. New columns on `interview_responses`: `input_mode`, `audio_upload_status`, `is_skipped`
4. New columns on `interviews`: `session_snapshot` JSONB, `paused_at` TIMESTAMP WITH TIME ZONE
5. New columns on `users`: `current_template_id` FK, `template_assigned_at`, `template_assigned_by`
6. New columns on `tags`: `is_active` BOOLEAN DEFAULT TRUE
7. New columns on `questions`: `is_active` BOOLEAN DEFAULT TRUE
8. New interview status value: 'paused' (add to existing ENUM)

### Data Model Removals
1. **`user_templates` table is removed.** Replaced by `users.current_template_id` FK + `template_assignment_history` table. All references to `user_templates` in the spec must be updated.

### Data Model Modifications
1. `interview_responses` audio fields: **no schema change**, but population timing changes — now populated progressively during the interview via `confirmAudioUpload`, not post-completion.

### Audio Pipeline Replacement
1. interview-spec-v1.md Section 5 "Post-Interview Audio Upload" is **fully superseded**. Replace with: "Audio segments are captured per-response via push-to-talk and uploaded progressively to S3 in the background during the interview. See conversation-protocol-spec-v3.md Section 2 for the complete audio architecture."
2. The `requestAudioUploadUrl(interviewId)` mutation is **removed** and replaced by per-response and per-draft presigned URL mutations.

### Follow-Up Trigger Architecture
1. interview-spec-v1.md Section 6 per-turn state update: remove the implication that triggers are pre-evaluated before passing to the LLM. Trigger definitions are passed in the system prompt; the LLM evaluates them. See Section 6 of this document.

### Technology Stack Additions
1. ElevenLabs TTS (in addition to existing ElevenLabs STT)
2. Server-Sent Events (SSE) for LLM response streaming
3. MediaRecorder API on the frontend for per-response audio capture

### Architecture Decision Updates
1. LLM conversation turns use streaming HTTP (SSE), not WebSocket
2. TTS synthesis happens on the frontend, not the backend
3. Auto-send on push-to-talk release (no explicit Send button for voice)
4. **Audio is per-response, not per-interview.** Push-to-talk creates natural audio segments. Progressive upload replaces batch upload.
5. **User-to-template is 1:1 via FK**, not many-to-many via junction table
6. **Tags and questions are soft-deleted**, never hard-deleted
7. **Follow-up triggers are LLM-evaluated**, not application-evaluated
8. **WebSocket connections are JWT-authenticated** via query parameter
9. **All reconciliation runs in one Lambda** on a 15-minute EventBridge cron

---

## 19. Implementation Task Mapping

For integration with `developmentTasks.md`, here is how this protocol maps to existing tasks:

| Protocol Section | Relevant Development Task | Notes |
|---|---|---|
| Audio architecture (Section 2) | Prisma Schema + Data Stack | Add response_drafts table with audio fields, audio_upload_status columns, S3 lifecycle policies per prefix |
| Burst handling protocol (Section 2) | Interview Engine + Live STT | New: implement metered relay buffer in Fargate proxy for initial audio burst, with configurable rate (default 1.5× real-time) and logging for tuning |
| STT WebSocket + auth (Sections 4.1, 12) | Interview Engine + Live STT | Add JWT validation on WS upgrade, audio_start/audio_end message types, MediaRecorder coordination |
| LLM SSE streaming (Section 4.1) | Interview Engine + Live STT | New: implement SSE endpoint with JWT auth, token streaming, sentence buffering |
| Follow-up trigger evaluation (Section 6) | Interview Engine + Live STT | Clarification: pass trigger definitions in system prompt, no app-side evaluation code needed |
| TTS integration (Section 4.1) | Frontend — Interview Experience | New: ElevenLabs TTS client, sentence-level synthesis, audio queue |
| Progressive audio upload (Section 2) | Frontend — Interview Experience + GraphQL API | New: background upload queue on frontend, presigned URL mutations, confirmAudioUpload mutations |
| Response drafts (Section 7) | Prisma Schema | Add response_drafts table with audio fields, input_mode column |
| User-template FK (Section 8) | Prisma Schema | Remove user_templates table, add FK + assignment_history table |
| Soft-delete (Section 9) | Prisma Schema + GraphQL API | Add is_active to tags and questions, update queries/mutations |
| Pause/Resume (Section 10) | Interview Engine + Live STT | New: pauseInterview/resumeInterview mutations, session snapshot |
| Inactivity handling (Section 11) | Interview Engine + Live STT | New: idle timer, heartbeat, auto-pause background process |
| Frontend state machine (Section 3) | Frontend — Interview Experience | New: implement full state machine with all transitions including UPLOADING, MEDIA_ERROR states |
| Microphone permission handling (Section 3) | Frontend — Interview Experience | New: eager permission request on interview start, MEDIA_ERROR state, graceful degradation to text-only, retry flow |
| Auto-send timer / PTT interaction (Section 3) | Frontend — Interview Experience | New: PTT mousedown/touchstart cancels auto-send timer in REVIEW state |
| UI layout (Section 13) | Frontend — Interview Experience | New: detailed layout spec, brand standard application, MEDIA_ERROR visual states for PTT button |
| SSE message types (Section 14) | Interview Engine + Live STT + Frontend — Interview Experience | New: define message schema, implement on both sides |
| Error recovery (Section 15) | Interview Engine + Live STT + Frontend — Interview Experience | New: all error handling flows including WS auth failure, audio upload failure |
| TTS token endpoint (Section 12) | GraphQL API | New: REST endpoint for TTS token |
| Reconciliation Lambda (Section 17) | Compute Stack (CDK) | **New: single Lambda + EventBridge rule (rate 15 min).** Handles stuck cleaning, failed audio uploads, and auto-abandonment. Must be added to ComputeStack CDK definition. |
| S3 lifecycle policies (Section 2) | Data Stack | Update: separate lifecycle policies for responses/ and drafts/ prefixes |