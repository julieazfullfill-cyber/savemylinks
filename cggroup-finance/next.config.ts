import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Chứng từ đính kèm tối đa 10MB (mặc định của server action là 1MB).
    serverActions: { bodySizeLimit: "11mb" },
  },
};

export default nextConfig;
