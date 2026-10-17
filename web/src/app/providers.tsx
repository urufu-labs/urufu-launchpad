'use client';

import { useState, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { wagmiConfig } from '@/lib/wagmi';
import { MockDataProvider } from '@/lib/mockDataMode';
import { ToastProvider } from '@/components/ui/Overlay';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <MockDataProvider>
          <ToastProvider>{children}</ToastProvider>
        </MockDataProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
