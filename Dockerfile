# Playwright's own image ships matching Chromium/deps preinstalled — far
# simpler than installing browsers into a generic node:slim image. Tag must
# match the `playwright` version in package.json (currently 1.62.1).
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Some Docker hosts (Hugging Face Spaces included) run the container as
# root with a read-only-ish default HOME; point HOME at a writable dir and
# reuse the base image's already-installed browsers instead of trying to
# download a second copy into $HOME/.cache.
ENV HOME=/tmp
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
# playwright is a runtime dependency (the resolver needs it when
# ENABLE_BROWSER=1), so this is a full install, not --omit=dev.
RUN npm ci

COPY . .

# 7860 is Hugging Face Docker Spaces' fixed public container port. Any other
# Docker host can override PORT/PUBLIC_URL at `docker run` time.
ENV PORT=7860
ENV ENABLE_BROWSER=1
EXPOSE 7860

CMD ["node", "server.js"]
