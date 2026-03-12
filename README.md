# [static-chic.online](https://static-chic.online)

A multi-tenant static site host. Sites are stored in S3 buckets and served via CloudFront. Supports custom domains and arbitrary rollbacks.

```bash
npm run publish # deploy
npx sls logs -f api # show logs
```

## Development

```bash
pipx install git-remote-s3
```

# TODO


- finish CLI
- cleanup
  - json vs text outputs from cli
  - Cloudfront 404 from S3 returns 403 Permission Denied instead
  - add Tags to everything for cost tracking
  - fix timeouts
    - create deploy sets up a temporary auth to write to s3, returns a url to post to
    - a separate background job detects new files and unzips them, then updates deployment
- production deploy
  - callback url
  - cli env var configuration: https://github.com/settings/apps/static-chic-online
- user caps
- frontend
- cli option for using git-remote-s3 directly
- Custom deployments
  - solution for env vars in cli - esbuild
  - flag for private-only in sls to disable github logins
  - cleanup admin cli
