import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/gradio-proxy/:path*',
        destination:
          'https://cooleschimo-neuroscan-backend.hf.space/:path*',
      },
    ];
  },
};

export default nextConfig;
