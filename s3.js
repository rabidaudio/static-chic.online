const { S3Client } = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')

const client = new S3Client()

const bucketName = process.env.TABLE_PREFIX

exports.upload = async (path, file) => {
  const params = {
    Bucket: bucketName,
    Key: path,
    Body: file
  }
  const task = new Upload({ client, params })
  await task.done()
}
