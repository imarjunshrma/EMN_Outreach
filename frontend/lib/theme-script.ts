// Runs before first paint (inline in <head>) so dark mode never flashes. Kept out of the client module.
// The public website and documentation are always light (PUBLIC_LIGHT); the app follows the user's choice.
export const PUBLIC_LIGHT = '^/(features|pricing|security|legal|docs|contact)?(/|$)';
export const THEME_SCRIPT = `(function(){try{if(new RegExp('${PUBLIC_LIGHT}').test(location.pathname)){document.documentElement.classList.remove('dark');return;}var t=localStorage.getItem('emn-theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;
