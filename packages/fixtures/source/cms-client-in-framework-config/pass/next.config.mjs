/** @type {import("next").NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [{ protocol: "https", hostname: "cdn.sanity.io" }],
  },
  async redirects() {
    return [{ source: "/menu.html", destination: "/menu", permanent: true }];
  },
};

export default nextConfig;
