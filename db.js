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

exports.create = async (table, data) => {
  const command = new PutCommand({
    TableName: `${tablePrefix}-${table}`,
    Item: data
  })
  await docClient.send(command)
  return data
}

exports.show = async (table, key) => {
  const command = new GetCommand({
    TableName: `${tablePrefix}-${table}`,
    Key: key // e.g. { userId }
  })
  const { Item } = await docClient.send(command)
  return Item
}
