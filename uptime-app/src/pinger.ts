import 'source-map-support/register'
import { Context } from 'aws-lambda'
import moment from 'moment-timezone'
import request from 'request'

import { servicesTable, metricsTable } from './core/constants'
import Services, { Rate, rates } from './core/services'

const services = new Services(servicesTable)

export type Metric = {
  id: string // service id (hash)
  time: string // ISO timestamp (range)
  start: string
  end: string
  type: 'success' | 'error'
  message: string
  raw: string
  latency: number
}

type CustomScheduledEvent = {
  id: string
  time: string
  rate: string
}

/**
 * This handler is meant to be invoked on a minutely basis using a
 *   scheduled CloudWatch event that triggers this Lambda function.
 * 
 * @param event the CloudWatch event
 * @param context the Lambda context
 */
export const handler = async (event: CustomScheduledEvent, context: Context): Promise<void> => {
  try {
    // Log the start time
    const start = moment()
    console.log(start.tz('America/New_York').format('[Invoked on] dddd, MMMM Do YYYY, [at] h:mm:ss SSS a z'))

    // Ensure the event is in the proper format
    console.log(event)
    if (!event.id || !event.time || !event.rate) throw new Error('The event is not in the proper format (id, time, rate)')

    // Ensure a valid rate was specified
    if (!rates.includes(event.rate as Rate)) throw new Error(`Invalid rate specified: ${event.rate}`)
    console.log(`The current rate is ${event.rate}`)

    // Lock for processing
    try {
      await metricsTable.client.put({
        TableName: metricsTable.name,
        ConditionExpression: 'attribute_not_exists (id)',
        Item: {
          id: `lock-${event.id}-${event.time}`,
          time: `${event.time}`,
          // expire at the end of this Lambda function's execution time (ttl is specified in seconds)
          ttl: Math.floor((Date.now() + context.getRemainingTimeInMillis()) / 1000)
        }
      }).promise()
    } catch (error) {
      if (error.code === 'ConditionalCheckFailedException') {
        console.log('Processing is locked by another function. Exiting.')
      }
      throw error
    }
    
    // Get all services and their applicable checks for the current rate, then run checks and return metrics
    let metrics: Array<Metric> = await Promise.all((await services.list())
    .map(service => {
      return service
      .checks
      .filter(check => check.rate === event.rate)
      .map(check => {
        return new Promise<Metric>((resolve, reject) => {
          let start = moment()
          request({
            uri: service.location,
            method: 'GET',
            time: true,
            timeout: 10000 // in ms, which equals 10 seconds
          }, (error, response) => {
            let end = moment()
            let metric: Metric = {
              id: service.id,
              time: event.time,
              start: start.toISOString(),
              end: end.toISOString(),
              type: (error || response.statusCode >= 400 || response.statusCode >= 500) ? 'error' : 'success',
              message: response.statusMessage,
              raw: JSON.stringify(response),
              latency: response.timingPhases!.firstByte
            }
            resolve(metric)
          })
        })
      })
    })
    .reduce((accumulator, current) => {
      return accumulator.concat(current)
    }, []))

    console.log(`Writing ${metrics.length} metrics ...`)

    // Write metrics to the table, in batches
    let last = 0
    let unprocessed: AWS.DynamoDB.DocumentClient.BatchWriteItemRequestMap | undefined = undefined
    while (true) {
      let request: AWS.DynamoDB.DocumentClient.BatchWriteItemInput = {
        RequestItems: {}
      }
      if (unprocessed) {
        request.RequestItems = unprocessed
      } else {
        request.RequestItems[metricsTable.name] = []
        let batch = metrics.slice(last, last + 25)
        if (batch.length === 0) break
        batch.forEach(metric => {
          request.RequestItems[metricsTable.name].push({
            PutRequest: {
              Item: metric
            }
          })
        })
      }
      if (Object.keys(request.RequestItems).length == 0 || request.RequestItems[metricsTable.name].length == 0) break
      let response = await metricsTable.client.batchWrite(request).promise()
      if (response.UnprocessedItems) unprocessed = response.UnprocessedItems
      else {
        unprocessed = undefined
        last = last + 25
      }
    }

    // Log the end time and execution duration
    const end = moment()
    console.log(end.tz('America/New_York').format('[Responding on] dddd, MMMM Do YYYY, [at] h:mm:ss SSS a z'))
    console.log(`Execution took ${end.diff(start, 'milliseconds')} milliseconds`)

    console.log('Responding with status:success ...')
  } catch (error) {
    console.error(error.message)
    console.log('Responding with status:error ...')
  }
}
