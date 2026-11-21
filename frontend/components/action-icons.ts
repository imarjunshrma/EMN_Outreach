import {
  Archive, ArrowLeft, Check, CheckCheck, Copy, Download, Eye, FlaskConical, Forward, Pause, Pencil, Play, Plus, RefreshCw, RotateCcw, Save, Search, Send,
  Settings2, ShieldCheck, Sparkles, Star, Trash2, Upload, Wand2, X, type LucideIcon,
} from 'lucide-react';

// A button's leading icon is picked from its first word, so every screen gets the same visual language for the
// same action without each page wiring icons by hand. Pass icon={null} on a Button to opt out.
const RULES: Array<[RegExp, LucideIcon]> = [
  [/^(new|add|create|\+)/i, Plus], [/^(save|update)/i, Save], [/^(delete|remove|revoke)/i, Trash2], [/^(cancel|dismiss|close|reject)/i, X],
  [/^(approve|confirm|verify|accept|mark .*done)/i, Check], [/^(approve & send|send)/i, Send], [/^(export|download)/i, Download], [/^(import|upload)/i, Upload],
  [/^(edit|rename)/i, Pencil], [/^(duplicate|copy|clone)/i, Copy], [/^(archive|unarchive)/i, Archive], [/^(pause|deactivate)/i, Pause], [/^(start|resume|activate|run)/i, Play],
  [/^(test|validate|check)/i, FlaskConical], [/^(preview|view|open|show)/i, Eye], [/^(refresh|sync|re-?run|retry|regenerate)/i, RefreshCw], [/^(restore|make active|rollback)/i, RotateCcw],
  [/^(search|find)/i, Search], [/^(ai |ask|generate|draft|summar|research)/i, Sparkles], [/^(forward)/i, Forward], [/^(back)/i, ArrowLeft], [/^(star|starred|unstar)/i, Star],
  [/^(submit)/i, CheckCheck], [/^(set up|enable|turn on)/i, ShieldCheck], [/^(configure|manage|change)/i, Settings2], [/^(auto|improve)/i, Wand2],
];

export function iconFor(label: unknown): LucideIcon | null {
  if (typeof label !== 'string') return null;
  const t = label.trim();
  for (const [re, icon] of RULES) if (re.test(t)) return icon;
  return null;
}
