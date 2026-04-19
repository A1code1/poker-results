/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  generateBuildId: () => require('crypto').randomBytes(8).toString('hex'),
}

module.exports = nextConfig
