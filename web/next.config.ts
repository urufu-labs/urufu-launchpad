import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      // Optional browser/native helpers pulled in by wallet connector packages.
      // The app only configures the injected connector, so these should not warn
      // when Next walks MetaMask/WalletConnect's optional paths.
      '@react-native-async-storage/async-storage': false,
      'pino-pretty': false,
    };
    return config;
  },
};

export default nextConfig;
