/** @type {import('next').NextConfig} */
export default {
  // ioredis and bcryptjs must run on the Node runtime, never the edge runtime.
  serverExternalPackages: ["ioredis", "bcryptjs", "@prisma/client"],
  transpilePackages: ["@deers/shared"],
};
