'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';

type Status = 'Disconnected' | 'Connecting' | 'Listening' | 'Thinking' | 'Speaking';
type CopilotResult = { threadId: string; answer: string; proposedActions: unknown[] };
type RealtimeEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  response?: { status?: string; output?: Array<{ type: string; name?: string; arguments?: string; call_id?: string }> };
};
type Connection = {
  peer: RTCPeerConnection;
  abort: AbortController;
  stream?: MediaStream;
  sessionId?: string;
  channel?: RTCDataChannel;
  timeout?: ReturnType<typeof setTimeout>;
};

function microphoneError(error: unknown) {
  if (!(error instanceof DOMException)) return 'Could not open the microphone. Try again.';
  switch (error.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone access is blocked. Open the settings icon beside this page’s address, set Microphone to Allow, then reload. If it is already allowed, check microphone access for your browser in your system settings.';
    case 'NotFoundError':
      return 'No microphone was found. Connect or enable a microphone and try again.';
    case 'NotReadableError':
      return 'The microphone could not start. Check your system input settings and close any app using it, then try again.';
    default:
      return 'Could not open the microphone. Try again.';
  }
}

export function CopilotVoice({ workspace, threadId, selection, onReply, disabled }: {
  workspace: string;
  threadId: string | null;
  selection: { leadId?: string; campaignId?: string };
  onReply: (result: CopilotResult) => void;
  disabled: boolean;
}) {
  const current = useRef<Connection | null>(null);
  const activeThread = useRef(threadId);
  const audio = useRef<HTMLAudioElement>(null);
  const [status, setStatus] = useState<Status>('Disconnected');
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [spokenReply, setSpokenReply] = useState('');
  const mounted = useRef(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  function recordEnd(sessionId: string, outcome: 'ended' | 'failed') {
    void api(`/w/${workspace}/copilot/voice/session/${sessionId}/end`, { body: { outcome } }).catch(() => undefined);
  }

  function dispose(outcome: 'ended' | 'failed' = 'ended') {
    const session = current.current;
    current.current = null;
    if (!session) return;
    if (session.sessionId) recordEnd(session.sessionId, outcome);
    clearTimeout(session.timeout);
    session.abort.abort();
    session.stream?.getTracks().forEach(track => track.stop());
    session.peer.close();
    if (audio.current) audio.current.srcObject = null;
  }

  // Unmount must use the latest dispose (it records the end against the current workspace), not the first render's.
  const disposeRef = useRef(dispose);
  disposeRef.current = dispose;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; disposeRef.current(); };
  }, []);
  useEffect(() => { activeThread.current = threadId; }, [threadId]);

  function end(outcome: 'ended' | 'failed' = 'ended') {
    dispose(outcome);
    setStatus('Disconnected');
    setMuted(false);
  }

  async function start() {
    if (current.current || pending) return;
    setError('');
    setTranscript('');
    setSpokenReply('');
    if (!window.isSecureContext) {
      setError('Open Outvexa over HTTPS or use localhost for local development, then try Start voice again.');
      return;
    }
    const policyDocument = document as Document & {
      permissionsPolicy?: { allowsFeature(feature: string): boolean };
      featurePolicy?: { allowsFeature(feature: string): boolean };
    };
    const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy;
    if (policy?.allowsFeature('microphone') === false) {
      setError('This page’s permissions policy blocks the microphone. Open Outvexa directly in a browser tab. If you are already in a tab, check the hosting proxy’s Permissions-Policy header.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      setError('Voice requires a secure browser connection with microphone and WebRTC support.');
      return;
    }

    const session: Connection = { peer: new RTCPeerConnection(), abort: new AbortController() };
    current.current = session;
    activeThread.current = threadId;
    setStatus('Connecting');
    const fail = (message: string) => {
      if (current.current !== session) return;
      end('failed');
      setError(message);
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(error => {
        throw new Error(microphoneError(error));
      });
      if (current.current !== session) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      session.stream = stream;
      const { peer } = session;
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      peer.ontrack = ({ streams }) => {
        if (audio.current) audio.current.srcObject = streams[0];
      };
      peer.onconnectionstatechange = () => {
        if (['disconnected', 'failed'].includes(peer.connectionState)) fail('Voice disconnected. Start voice again to continue this conversation.');
      };
      const channel = session.channel = peer.createDataChannel('oai-events');
      const send = (payload: object) => {
        if (current.current === session && channel.readyState === 'open') channel.send(JSON.stringify(payload));
      };
      let turn = 0;
      let dispatchedTurn = 0;
      let work = Promise.resolve();
      channel.onopen = () => {
        clearTimeout(session.timeout);
        setStatus('Listening');
      };
      channel.onclose = () => fail('Voice disconnected. Start voice again to continue this conversation.');
      channel.onmessage = ({ data }: MessageEvent<string>) => {
        if (current.current !== session) return;
        let event: RealtimeEvent;
        try { event = JSON.parse(data); } catch { return; }
        switch (event.type) {
          case 'input_audio_buffer.speech_started':
            setStatus('Listening');
            setTranscript('');
            setSpokenReply('');
            break;
          case 'input_audio_buffer.speech_stopped':
            turn++;
            setStatus('Thinking');
            break;
          case 'conversation.item.input_audio_transcription.completed':
            setTranscript(event.transcript ?? '');
            break;
          case 'output_audio_buffer.started':
            setStatus('Speaking');
            break;
          case 'output_audio_buffer.stopped':
          case 'output_audio_buffer.cleared':
            setStatus('Listening');
            break;
          case 'response.output_audio_transcript.delta':
            setSpokenReply(text => text + (event.delta ?? ''));
            break;
          case 'error':
            setError('Voice received an error. You can end and restart the session.');
            break;
          case 'response.done': {
            if (event.response?.status !== 'completed') return;
            const call = event.response.output?.find(item => item.type === 'function_call' && item.name === 'ask_outvexa');
            const callId = call?.call_id;
            if (!callId || dispatchedTurn === turn) return;
            const requestedTurn = turn;
            dispatchedTurn = requestedTurn;
            work = work.then(async () => {
              if (current.current !== session) return;
              setPending(true);
              let output: object;
              try {
                const { question } = JSON.parse(call.arguments ?? '{}') as { question?: string };
                if (typeof question !== 'string' || !question.trim() || question.length > 4000) throw new Error('The voice request was invalid.');
                const result = await api<CopilotResult>(`/w/${workspace}/copilot/ask`, {
                  body: { threadId: activeThread.current, question, ...selection },
                });
                activeThread.current = result.threadId;
                if (mounted.current) onReply(result);
                output = { answer: result.answer, actionsAwaitingConfirmation: result.proposedActions.length };
              } catch (err) {
                output = { error: err instanceof Error ? err.message : 'Copilot could not answer.' };
              } finally {
                setPending(false);
              }
              send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) } });
              if (turn === requestedTurn) send({ type: 'response.create' });
            });
            break;
          }
        }
      };

      session.timeout = setTimeout(() => fail('Voice could not connect in time. Try again.'), 30_000);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const { clientSecret, sessionId } = await api<{ clientSecret: string; sessionId: string }>(`/w/${workspace}/copilot/voice/session`, { body: { threadId } });
      if (current.current !== session) {
        recordEnd(sessionId, 'ended');
        return;
      }
      session.sessionId = sessionId;
      const response = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp,
        signal: session.abort.signal,
      });
      if (!response.ok) throw new Error(`OpenAI could not connect voice (HTTP ${response.status}).`);
      await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Could not start voice.');
    }
  }

  function toggleMute() {
    const tracks = current.current?.stream?.getAudioTracks();
    if (!tracks?.length) return;
    for (const track of tracks) track.enabled = muted;
    setMuted(!muted);
  }

  function interrupt() {
    const channel = current.current?.channel;
    if (channel?.readyState !== 'open') return;
    channel.send(JSON.stringify({ type: 'output_audio_buffer.clear' }));
  }

  return (
    <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
      <audio ref={audio} autoPlay />
      <div className="flex flex-wrap items-center gap-2">
        {status === 'Disconnected'
          ? <Button variant="secondary" disabled={disabled || pending} onClick={() => void start()}>Start voice</Button>
          : <>
            <Button variant="secondary" disabled={status === 'Connecting'} onClick={toggleMute}>{muted ? 'Resume microphone' : 'Mute microphone'}</Button>
            {status === 'Speaking' && <Button variant="secondary" onClick={interrupt}>Interrupt</Button>}
            <Button variant="ghost" onClick={() => end()}>End voice</Button>
          </>}
        {(status !== 'Disconnected' || pending) && <span className="inline-flex items-center gap-2 text-sm" role="status">
          <span className={status === 'Listening' && !muted ? 'h-2 w-2 animate-pulse rounded-full bg-brand-500 motion-reduce:animate-none' : 'h-2 w-2 rounded-full bg-slate-400'} />
          {pending ? 'Copilot is working' : muted && status === 'Listening' ? 'Microphone muted' : status}
        </span>}
      </div>
      {transcript && <p className="whitespace-pre-wrap text-sm text-slate-600"><b>You</b> · {transcript}</p>}
      {spokenReply && <p className="whitespace-pre-wrap text-sm text-slate-600"><b>Copilot</b> · {spokenReply}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
