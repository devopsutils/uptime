import KoaRouter from 'koa-router'
import uuid from 'uuid/v4'
import moment from 'moment-timezone'
import cronParser from 'cron-parser'

import { servicesTable, metricsTable } from './clients'
import {
  HttpCompatibleError,
  Rate,
  Metric,
  Status,
  Service, CreateService, createServiceSchema, UpdateService, updateServiceSchema,
  Message, CreateMessage, createMessageSchema,
} from './types'

export const rates: Array<Rate> = [ '1 minute', '5 minutes', '15 minutes', '30 minutes', '1 hour' ]

export const cronForRate = {
  '1 minute': '* * * * ? *',
  '5 minutes': '0/5 * * * ? *',
  '15 minutes': '0/15 * * * ? *',
  '30 minutes': '0/30 * * * ? *',
  '1 hour': '0 * * * ? *'
}

export const list = async (): Promise<Array<Service>> => {
  let items: Array<Service> = []
  let request: AWS.DynamoDB.DocumentClient.ScanInput = {
    TableName: servicesTable.name,
    FilterExpression: 'begins_with (id, :prefix)',
    ExpressionAttributeValues: {
      ':prefix': 'service'
    }
  }
  let dataLoaded = false
  let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined = undefined
  while (!dataLoaded) {
    if (lastEvaluatedKey) request.ExclusiveStartKey = lastEvaluatedKey
    let response = await servicesTable.client.scan(request).promise()
    if (response.Items) items.push(...response.Items as Array<Service>)
    if (response.LastEvaluatedKey) lastEvaluatedKey = response.LastEvaluatedKey
    else dataLoaded = true
  }
  items = await Promise.all(items.map(async item => {
    item.metrics = await readMetrics(item.id)
    return item
  }))
  return items
}

export const listSamples = async (): Promise<Array<Service>> => {
  let samples: Array<{ id: string, title: string, location: string, status: Status }> = [
    { id: 'service-sample-1', title: 'Backend', location: 'https://httpstat.us/201', status: 'Operational' },
    { id: 'service-sample-2', title: 'Frontend', location: 'https://httpstat.us/200', status: 'Operational' },
    { id: 'service-sample-3', title: 'API', location: 'https://httpstat.us/503', status: 'Maintenance' },
    { id: 'service-sample-4', title: 'Payments', location: 'https://httpstat.us/204', status: 'Operational' },        
    { id: 'service-sample-5', title: 'Helpdesk', location: 'https://httpstat.us/500', status: 'Down' }
  ]
  return samples.map<Service>(sample => {
    return {
      id: sample.id,
      name: encodeURIComponent(sample.title.toLowerCase()),
      title: sample.title,
      location: sample.location,
      status: sample.status,
      metrics: [...Array(15).keys()].map(n => {
        return {
          id: sample.id,
          time: moment().subtract(n, 'days').toISOString(),
          start: moment().subtract(n, 'days').toISOString(),
          end: moment().subtract(n, 'days').add(2, 'seconds').toISOString(),
          type: (n != 7 && n != 8 && n != 14) ? 'success' : 'error',
          code: (n != 7 && n != 8 && n != 14) ? 200 : 500,
          message: (n != 7 && n != 8 && n != 14) ? '200 OK': '500 Internal server error',
          latency: Math.floor(Math.random() * (4000 - 10)) + 10
        }
      }),
      checks: [
        {
          rate: '5 minutes',
          nextCheck: moment().add(5, 'minutes').toISOString()
        },
        {
          rate: '1 hour',
          nextCheck: moment().add(1, 'hour').toISOString()
        }
      ],
      feedback: [
        {
          submitted: moment().subtract(3, 'months').subtract(4, 'hours').subtract(23, 'minutes').toISOString(),
          content: 'You guys are awesome! The service is so fast. Keep the good work going!'
        },
        {
          submitted: moment().subtract(1, 'days').subtract(14, 'seconds').toISOString(),
          content: 'That has to be a fake review down there. This has been down for hours and no-one is on-call!'
        }
      ],
      messages: (sample.title === 'API') ? [
        {
          id: uuid(),
          submitted: moment().subtract(3, 'hours').toISOString(),
          content: 'Scheduled database backup is in progress.',
          summary: 'API is currently under maintenance.',
          status: 'Maintenance',
          signature: 'Admin',
          active: true
        }
      ] : (sample.title === 'Helpdesk' ) ? [
        {
          id: uuid(),
          submitted: moment().subtract(5, 'minutes').toISOString(),
          content: `Triage meeting invites will be sent shortly.`,
          summary: 'Helpdesk is experiencing issues.',
          status: 'Down',
          signature: 'Admin',
          active: true
        }
      ] : (sample.title === 'Backend' ) ? [
        {
          id: uuid(),
          submitted: moment().subtract(1, 'days').toISOString(),
          content: 'Thank you for your patience during issue resolution.',
          summary: 'Backend is operational after being down for 2 hours.',
          status: 'Operational',
          signature: 'Admin',
          active: false
        },
        {
          id: uuid(),
          submitted: moment().subtract(1, 'days').subtract(2, 'hours').toISOString(),
          content: 'Services are experiencing request latencies of more than 7 seconds on average.',
          summary: 'Backend is down.',
          status: 'Down',
          signature: 'Admin',
          active: false
        },
        {
          id: uuid(),
          submitted: moment().subtract(1, 'year').subtract(3, 'months').toISOString(),
          content: 'Restarting production servers 1, 2, and 3.',
          summary: 'Scheduled backend server restarts.',
          status: 'Maintenance',
          signature: 'Admin',
          active: false
        }
      ] :[]
    }
  })
}

export const createSamples = async (): Promise<void> => {
  let samples = await listSamples() // samples array should be no more than 5 elements (TODO handle)
  let request: AWS.DynamoDB.DocumentClient.BatchWriteItemInput = {
    RequestItems: {}
  }
  request.RequestItems[servicesTable.name] = []
  samples.forEach((sample, index) => {
    request.RequestItems[servicesTable.name].push({
      PutRequest: {
        Item: sample
      }
    })
  })
  await servicesTable.client.batchWrite(request).promise()
}

export const create = async (createService: CreateService): Promise<Service> => {
  let validation = createServiceSchema.validate<CreateService>(createService, { abortEarly: false, stripUnknown: true })
  if (validation.error) {
    console.error(validation.error.message)
    throw new HttpCompatibleError(400, 'Bad request')
  }
  let service: Service = {
    ...validation.value,
    id: `service-${uuid()}`,
    name: encodeURIComponent(validation.value.title.toLowerCase()),
    checks: validation.value.checks.map(check => {
      return {
        rate: check.rate,
        nextCheck: cronParser.parseExpression(cronForRate[check.rate].replace('?', '*')).next().toISOString()
      }
    }),
    metrics: [],
    messages: [],
    feedback: []
  }
  await servicesTable.client.put({
    TableName: servicesTable.name,
    ConditionExpression: 'attribute_not_exists (id)',
    Item: service
  }).promise()
  return service
}

export const update = async (id: string, updateService: UpdateService): Promise<Service> => {
  let validation = updateServiceSchema.validate<UpdateService>(updateService, { abortEarly: false, stripUnknown: true })
  if (validation.error) {
    console.error(validation.error.message)
    throw new HttpCompatibleError(400, 'Bad request')
  }
  let service = await read(id)
  if (!service) throw new HttpCompatibleError(404, 'Not found')
  await servicesTable.client.put({
    TableName: servicesTable.name,
    ConditionExpression: 'attribute_exists (id)',
    Item: {
      ...service,
      ...validation.value
    }
  }).promise()
  return service
}

export const createMessage = async (serviceId: string, createMessage: CreateMessage): Promise<Message> => {
  let validation = createMessageSchema.validate<CreateMessage>(createMessage, { abortEarly: false, stripUnknown: true })
  if (validation.error) {
    console.error(validation.error.message)
    throw new HttpCompatibleError(400, 'Bad request')
  }
  let service = await read(serviceId)
  if (!service) throw new HttpCompatibleError(404, 'Bad request')
  let message: Message = {
    ...validation.value,
    id: `message-${uuid()}`,
    submitted: moment().toISOString(),
    active: true
  }
  service.messages.push(message)
  service.status = message.status
  await servicesTable.client.put({
    TableName: servicesTable.name,
    ConditionExpression: 'attribute_exists (id)',
    Item: service
  }).promise()
  return message
}

export const archiveMessage = async (serviceId: string, messageId: string): Promise<void> => {
  let service = await read(serviceId)
  if (!service) throw new HttpCompatibleError(404, 'Not found')
  let messageIndex = service.messages.findIndex(message => message.id === messageId)
  if (messageIndex < 0) throw new HttpCompatibleError(404, 'Not found')  
  service.messages[messageIndex].active = false  
  let sortedRecentToOldest = service.messages.slice().sort((a, b) => moment(b.submitted).valueOf() - moment(a.submitted).valueOf())
  let recentActiveMessage = sortedRecentToOldest.find(message => message.active)
  if (recentActiveMessage) service.status = recentActiveMessage.status
  await servicesTable.client.put({
    TableName: servicesTable.name,
    ConditionExpression: 'attribute_exists (id)',
    Item: service
  }).promise()
}

export const deleteMessage = async (serviceId: string, messageId: string): Promise<void> => {
  let service = await read(serviceId)
  if (!service) throw new HttpCompatibleError(404, 'Not found')  
  if (!service.messages.some(message => message.id === messageId)) throw new HttpCompatibleError(404, 'Not found')
  service.messages = service.messages.filter(message => message.id !== messageId)
  let sortedRecentToOldest = service.messages.slice().sort((a, b) => moment(b.submitted).valueOf() - moment(a.submitted).valueOf())
  let recentActiveMessage = sortedRecentToOldest.find(message => message.active)
  if (recentActiveMessage) service.status = recentActiveMessage.status
  await servicesTable.client.put({
    TableName: servicesTable.name,
    ConditionExpression: 'attribute_exists (id)',
    Item: service
  }).promise()
}

export const read = async (id: string): Promise<Service | undefined> => {
  let response = await servicesTable.client.get({
    TableName: servicesTable.name,
    Key: {
      id
    }
  }).promise()
  return response.Item as Service | undefined
}

export const readMetrics = async (id: string): Promise<Array<Metric>> => {
  let response = await metricsTable.client.query({
    TableName: metricsTable.name,
    KeyConditionExpression: '#id = :id AND #time BETWEEN :fromDateTime AND :toDateTime',
    ScanIndexForward: false, // read in descending order (most recent first)
    Limit: 120, // max 120 records
    ExpressionAttributeNames: {
      '#id': 'id',
      '#time': 'time',
      '#start': 'start',
      '#end': 'end',
      '#type': 'type',
      '#code': 'code',
      '#message': 'message',
      '#latency': 'latency'
    },
    ExpressionAttributeValues: {
      ':id': id,
      ':fromDateTime': moment().subtract(1, 'day').toISOString(),
      ':toDateTime': moment().toISOString()
    },
    ProjectionExpression: '#time, #start, #end, #type, #code, #message, #latency'
  }).promise()
  return response.Items as Array<Metric>
}

export const del = async (id: string): Promise<void> => {
  await servicesTable.client.delete({
    TableName: servicesTable.name,
    Key: {
      id
    }
  }).promise()
}

export const router = new KoaRouter()
.get('/services', async (ctx, next) => {
  ctx.body = await list()
  ctx.status = 200
  await next()
})
.post('/services', async (ctx, next) => {
  ctx.body = await create(ctx.request.body)
  ctx.status = 201
  await next()
})
.get('/services/:id', async (ctx, next) => {
  let result = await read(ctx.params.id)
  if (!result) throw new HttpCompatibleError(404, 'Not found')
  ctx.body = result
  ctx.status = 200
  await next()
})
.patch('/services/:id', async (ctx, next) => {
  ctx.body = await update(ctx.params.id, ctx.request.body)
  ctx.status = 200
  await next()
})
.del('/services/:id', async (ctx, next) => {
  await del(ctx.params.id)
  ctx.status = 204
  await next()
})
.post('/services/:id/messages', async (ctx, next) => {
  await createMessage(ctx.params.id, ctx.request.body)
  ctx.status = 201
  await next()
})
.put('/services/:serviceId/messages/:messageId/archive', async (ctx, next) => {
  await archiveMessage(ctx.params.serviceId, ctx.params.messageId)
  ctx.status = 204
  await next()
})
.del('/services/:serviceId/messages/:messageId', async (ctx, next) => {
  await deleteMessage(ctx.params.serviceId, ctx.params.messageId)
  ctx.status = 204
  await next()
})
.get('/services/:id/metrics', async (ctx, next) => {
  ctx.body = await readMetrics(ctx.params.id)
  ctx.status = 200
  await next()
})
.put('/samples', async (ctx, next) => {
  await createSamples()
  ctx.status = 204
  await next()
})
