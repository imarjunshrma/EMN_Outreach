'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loading } from '@/components/ui';

/** The v1.2 admin page moved to the platform console. */
export default function AdminRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/platform'); }, [router]);
  return <Loading label="Opening the platform console…" />;
}
