const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')

const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand
} = require('@aws-sdk/lib-dynamodb')

const client = new DynamoDBClient()
const docClient = DynamoDBDocumentClient.from(client)

const NODE_ENV = process.env.NODE_ENV || 'dev'
const tablePrefix = `rabidaudio-cheap-static-sites-${NODE_ENV}`

exports.createUser = async (user) => {
  const command = new PutCommand({
    TableName: `${tablePrefix}-users`,
    Item: user
  })
  await docClient.send(command)
  return user
}

exports.getUser = async (userId) => {
  const command = new GetCommand({
    TableName: `${tablePrefix}-users`,
    Key: { userId }
  })
  const { Item } = await docClient.send(command)
  return Item
}
