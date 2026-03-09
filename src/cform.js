const fs = require('node:fs')
const path = require('node:path')

const {
  CloudFormationClient,
  CreateStackCommand,
  UpdateStackCommand,
  DeleteStackCommand,
  StackNotFoundException
} = require('@aws-sdk/client-cloudformation')

const logger = require('./logger').getLogger()

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

const generateStackName = (siteId) => `${process.env.APP_ID}-${siteId}`

exports.createSite = async ({ siteId, customDomain }) => {
  const stackName = generateStackName(siteId)
  const params = {
    StackName: stackName,
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
  logger.http(`cloudformation: create stack ${stackName}`)
  const { StackId, OperationId } = await client.send(new CreateStackCommand(params))
  return { stackId: StackId, operationId: OperationId }
}

exports.updateParams = async (stackId, { siteId, customDomain }) => {
  const cmd = new UpdateStackCommand({
    StackName: stackId,
    TemplateBody: template,
    Parameters: generateSiteParameters({ siteId, customDomain })
  })
  logger.http(`cloudformation: update stack ${stackId}`)
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

exports.deleteStack = async (siteId) => {
  const stackName = generateStackName(siteId)
  try {
    logger.http(`cloudformation: delete stack ${stackName}`)
    await client.send(new DeleteStackCommand({
      StackName: stackName
    }))
  } catch (err) {
    if (err instanceof StackNotFoundException) {
      return
    }
    throw err
  }
}
