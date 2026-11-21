'use client';
import { createContext, useContext } from 'react';
import type { LucideIcon } from 'lucide-react';

/** The current screen's navigation icon and section, provided by the workspace layout so every PageHeader shows it. */
export const PageMeta = createContext<{ icon?: LucideIcon; group?: string } | null>(null);
export const usePageMeta = () => useContext(PageMeta);
