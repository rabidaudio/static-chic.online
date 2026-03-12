# [static-chic.online](https://static-chic.online)

A multi-tenant static site host. Sites are stored in S3 buckets and served via CloudFront. Supports custom domains and arbitrary rollbacks.

```bash
./bin/admin # admin management cli
npm run serve # run a local tunnel to test API
npm run publish # deploy
npx sls logs -f api # show logs
```

# API

```bash
# Deploy
curl -X POST \
    -H 'Authorization: Bearer <token>' \    # if using user authentication
    -H 'Deploy-Key: <deploy key>' \         # in place of bearer token, the deploy key allows creation
    \                                       # and promotion of sites but no other permissions (for automation)
    -H 'Content-Type: application/gzip' \   # your compiled site content should be uploaded
    --data-binary @mysite.tar.gz \          # as the binary body of the request in a gzipped tarball
    https://api.static-chic.online/sites/:siteId/deployments
# 200 Response: {
#     "status": "OK",
#     "data": {
#         siteId: 'prison-mentor-ydd8c',
#         deploymentId: '0000019cc58b808eb0c1dfe5'
#         createdAt: '2026-03-06T23:46:19.919Z',
#     }
# }

# Deployments are staged but not immediately deployed.
# To make the deployment live, promote it:
curl -X POST \
    -H 'Authorization: Bearer <token>' \
    -H 'Deploy-Key: <deploy key>' \
    https://api.static-chic.online/sites/:siteId/deployments/:deploymentId/promote

# Rollback is as simple as promoting a previous deployment
```

## Development

```bash
pipx install git-remote-s3
```

# TODO

- deploy keys
  - regenerate deploy key command
  - show current deployment
- deploy functions
  - add optional messages to deployments
  - use git-short-sha algorithm to show short deployment ids
- finish CLI
- cleanup
  - breakup app
  - complete integration tests
  - json vs text outputs from cli
  - Cloudfront 404 from S3 returns 403 Permission Denied instead
  - add Tags to everything for cost tracking
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
