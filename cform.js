const fs = require('node:fs')
const path = require('node:path')

const {
  CloudFormationClient,
  CreateStackCommand,
  UpdateStackCommand,
  DescribeStackSetOperationCommand
} = require('@aws-sdk/client-cloudformation')

const client = new CloudFormationClient()

const template = fs.readFileSync(path.resolve(__dirname, 'tenant.template.yaml')).toString('utf8')

const generateSiteParameters = ({ siteId, customDomain }) => ([
  {
    ParameterKey: 'HostedZoneId',
    ParameterValue: process.env.HOSTED_ZONE_ID || ''
  },
  {
    ParameterKey: 'SitesDomain',
    ParameterValue: process.env.SITES_DOMAIN || ''
  },
  {
    ParameterKey: 'DistributionId',
    ParameterValue: process.env.DISTRIBUTION_ID || ''
  },
  {
    ParameterKey: 'ConnectionGroupId',
    ParameterValue: process.env.CONNECTION_GROUP_ID || ''
  },
  {
    ParameterKey: 'DistributionDomain',
    ParameterValue: process.env.DISTRIBUTION_DOMAIN || ''
  },

  {
    ParameterKey: 'SiteId',
    ParameterValue: siteId
  },
  {
    ParameterKey: 'CustomDomain',
    ParameterValue: customDomain || ''
  }
])

const generateStackName = (siteId) => `${process.env.TABLE_PREFIX}-${siteId}`

exports.createSite = async ({ siteId, customDomain }) => {
  const params = {
    StackName: generateStackName(siteId),
    TemplateBody: template,
    Parameters: generateSiteParameters({ siteId, customDomain }),
    Tags: [
      {
        Key: 'app',
        Value: process.env.APP_NAME || ''
      },
      {
        Key: 'stage',
        Value: process.env.STAGE || 'dev'
      }
    ]
  }

  const { StackId, OperationId } = await client.send(new CreateStackCommand(params))
  return { stackId: StackId, operationId: OperationId }
}

exports.updateParams = async (stackId, { siteId, customDomain }) => {
  const cmd = new UpdateStackCommand({
    StackName: stackId,
    TemplateBody: template,
    Parameters: generateSiteParameters({ siteId, customDomain })
  })

  const { StackId, OperationId } = await client.send(cmd)
  return { stackId: StackId, operationId: OperationId }
}

// exports.getStackStatus = async (siteId, operationId) => {
//   const cmd = new DescribeStackSetOperationCommand({
//     StackSetName: generateStackName(siteId),
//     OperationId: operationId
//   })
//   const { StackSetOperation } = await client.send(cmd)
//   // StackSetOperation.Status
//   return StackSetOperation
// }

// TODO: get events

// TODO: delete stack
