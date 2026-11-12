/** An invented settings file: it lets the image address fetch from any host. */
module.exports = {
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};
