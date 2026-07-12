# Publishing

The release command publishes all four workspace packages to npm and the Docker image to GitHub Container Registry. Prepare a release by bumping every package to the same version:

```bash
# Increment the current version
pnpm version:bump patch

# Or set a specific version
pnpm version:bump 1.0.0
```

The bump command also updates the private root package so every `package.json` stays in sync. It accepts `major`, `minor`, `patch`, and pnpm's prerelease increments. It changes the manifests without creating a Git commit or tag, so you can review and commit the version bump yourself.

Once the version bump is committed, run the release command from a clean working tree:

```bash
# Sign in once on your machine
npm login
docker login ghcr.io

# Confirm that the npm login works
npm whoami

# Check the packages and build the image without publishing anything
pnpm publish:all --dry-run

# Publish the npm packages and Docker tags 0.1.0 and latest
pnpm publish:all
```

The publish command checks npm authentication before it builds anything. If `npm whoami` fails, run `npm login` again. For CI, configure an npm access token as `NODE_AUTH_TOKEN` instead of using an interactive login.

The Docker image defaults to `ghcr.io/churichard/fluxmail-mcp`. Override it for another registry or repository:

```bash
pnpm publish:all --docker-image docker.io/your-name/fluxmail
```

GHCR marks a package private the first time it is pushed, and the README tells users to pull it without logging in. After the first publish, make the image public once: open [the package page](https://github.com/churichard/fluxmail-mcp/pkgs/container/fluxmail-mcp) → Package settings → Danger Zone → Change visibility → Public. GitHub has no API for this, so it has to happen in the UI, but the setting sticks for every later push. Confirm it worked with an anonymous pull:

```bash
docker logout ghcr.io
docker pull ghcr.io/churichard/fluxmail-mcp:latest
```

The image is built for both `linux/amd64` and `linux/arm64`, so servers on either architecture can pull it. This needs a Docker setup that can build multi-platform images: Docker Desktop handles it out of the box; on plain Docker Engine, create a builder first with `docker buildx create --use`. Set `DOCKER_PLATFORMS` to change the target platforms.

Use `--tag next` for a prerelease. This applies the `next` tag to both npm and Docker instead of moving `latest`.

The command publishes npm packages before pushing Docker tags. It will not overwrite an existing versioned Docker tag; increment all package versions before publishing another build.
