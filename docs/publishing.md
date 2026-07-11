# Publishing

The release command publishes all three workspace packages to npm and the Docker image to GitHub Container Registry. Give every package the same version before running it.

```bash
# Sign in once on your machine
npm login
docker login ghcr.io

# Check the packages and build the image without publishing anything
pnpm publish:all --dry-run

# Publish the npm packages and Docker tags 0.1.0 and latest
pnpm publish:all
```

The Docker image defaults to `ghcr.io/churichard/fluxmail-mcp`. Override it for another registry or repository:

```bash
pnpm publish:all --docker-image docker.io/your-name/fluxmail
```

The image is built for both `linux/amd64` and `linux/arm64`, so servers on either architecture can pull it. This needs a Docker setup that can build multi-platform images: Docker Desktop handles it out of the box; on plain Docker Engine, create a builder first with `docker buildx create --use`. Set `DOCKER_PLATFORMS` to change the target platforms.

Use `--tag next` for a prerelease. This applies the `next` tag to both npm and Docker instead of moving `latest`.

The command publishes npm packages before pushing Docker tags. It will not overwrite an existing versioned Docker tag; increment all package versions before publishing another build.
