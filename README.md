# static-chic.online

A multi-tenant static site host. Sites are stored in S3 buckets and served via CloudFront. Supports custom domains and arbitrary rollbacks.

```bash
npm run manage # admin management cli
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

<subdomain>.sites.static-chic.online
api.static-chic.online
static-chic.online -> frontend 

# TODO

- DELETE deployments
- DELETE site
- logger
- exclude on zip
- rename db create to put
- store with git-remote-s3
- deploy keys
- production deploy
- Github authentication
- deploy CLI
- frontend
- add Tags to everything for cost tracking


https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html
