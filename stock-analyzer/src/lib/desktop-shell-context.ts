import { createContext } from 'react';

/**
 * True while the AppShell has mounted the desktop sidebar. The page-level tab
 * bar then renders nothing, so the app exposes exactly one primary <nav>.
 */
export const DesktopSidebarMountedContext = createContext(false);
