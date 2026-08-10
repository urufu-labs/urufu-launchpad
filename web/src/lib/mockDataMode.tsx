'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

const STORAGE_KEY = 'urufu:mock-data-enabled';

// Mock fixtures are available for local development and deliberate review deployments
// only. Production must opt in at build time before any fixture can render.
export const mockDataAvailable =
  process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_ENABLE_HOME_PREVIEW === 'true';

type MockDataMode = {
  available: boolean;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
};

const MockDataContext = createContext<MockDataMode>({
  available: false,
  enabled: false,
  setEnabled: () => {},
});

export function MockDataProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(mockDataAvailable);

  useEffect(() => {
    if (!mockDataAvailable) return;
    setEnabledState(window.localStorage.getItem(STORAGE_KEY) !== 'off');
  }, []);

  useEffect(() => {
    document.body.dataset.mock = enabled ? 'on' : 'off';
  }, [enabled]);

  const setEnabled = useCallback((next: boolean) => {
    if (!mockDataAvailable) return;
    setEnabledState(next);
    window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
  }, []);

  const value = useMemo(
    () => ({ available: mockDataAvailable, enabled: mockDataAvailable && enabled, setEnabled }),
    [enabled, setEnabled],
  );

  return <MockDataContext.Provider value={value}>{children}</MockDataContext.Provider>;
}

export function useMockDataMode(): MockDataMode {
  return useContext(MockDataContext);
}
