'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { describeError } from '@/lib/api';
import { useWs, useWsMutation } from '@/lib/hooks';

const ACCEPT = '.xlsx,.csv,.pdf,.docx,.txt,.md,.json,.html';
const MAX_FILES = 20;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

/** Problems the server would refuse anyway, explained before anything is sent. */
function selectionProblem(files: File[]) {
  if (files.length > MAX_FILES) return `Choose ${MAX_FILES} files or fewer for each import.`;
  if (files.some((file) => file.size > MAX_FILE_BYTES) || files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) {
    return 'Choose files within the 20 MB per-file and 40 MB total limits.';
  }
  return null;
}

/** One click: choosing the files starts the upload, then opens the new import. */
export function ImportUploader({ label = 'Upload files', variant = 'primary', hint = true }: { label?: string; variant?: 'primary' | 'secondary'; hint?: boolean }) {
  const ws = useWs();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const upload = useWsMutation<File[], { id: string }>((selection) => {
    const form = new FormData();
    selection.forEach((file) => form.append('files', file));
    return { path: '/ai-studio/imports', form };
  }, { onSuccess: ({ id }) => router.push(`/w/${ws}/ai-studio/imports/${id}`) });

  function choose(files: File[]) {
    upload.reset();
    setProblem(null);
    if (!files.length) return;
    const issue = selectionProblem(files);
    if (issue) setProblem(issue);
    else upload.mutate(files);
  }

  return (
    <div className="space-y-2">
      <input ref={input} type="file" multiple accept={ACCEPT} aria-label="Choose files" className="sr-only" tabIndex={-1} disabled={upload.isPending}
        onChange={(event) => { choose(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <Button variant={variant} loading={upload.isPending} onClick={() => input.current?.click()}>{upload.isPending ? 'Uploading…' : label}</Button>
      {hint && <p className="text-xs text-slate-500 dark:text-slate-400">XLSX, CSV, PDF, DOCX, TXT, MD, JSON or HTML. Up to 20 files, 20 MB each and 40 MB in total. The upload starts as soon as you choose the files.</p>}
      {problem && <Notice kind="warning">{problem}</Notice>}
      {upload.error && <Notice kind="danger">{describeError(upload.error)}</Notice>}
    </div>
  );
}
