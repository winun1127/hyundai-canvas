import { Duration } from '@/lib/duration'
import {
  getModelClient,
  getDefaultMode,
  getLangGraphClient,
} from '@/lib/models'
import { LLMModel, LLMModelConfig } from '@/lib/models'
import { toPrompt, toLangGraphPrompt } from '@/lib/prompt'
import ratelimit from '@/lib/ratelimit'
import { fragmentSchema as schema } from '@/lib/schema'
import { Templates } from '@/lib/templates'
import { streamObject, LanguageModel, CoreMessage } from 'ai'

export const maxDuration = 60

const rateLimitMaxRequests = process.env.RATE_LIMIT_MAX_REQUESTS
  ? parseInt(process.env.RATE_LIMIT_MAX_REQUESTS)
  : 10
const ratelimitWindow = process.env.RATE_LIMIT_WINDOW
  ? (process.env.RATE_LIMIT_WINDOW as Duration)
  : '1d'

export async function POST(req: Request) {
  const {
    messages,
    userID,
    template,
    model,
    config,
    quality,
  }: {
    messages: CoreMessage[]
    userID: string
    template: Templates
    model: LLMModel
    config: LLMModelConfig
    quality: 'High' | 'Low'
  } = await req.json()

  const limit = !config.apiKey
    ? await ratelimit(userID, rateLimitMaxRequests, ratelimitWindow)
    : false

  if (limit) {
    return new Response('You have reached your request limit for the day.', {
      status: 429,
      headers: {
        'X-RateLimit-Limit': limit.amount.toString(),
        'X-RateLimit-Remaining': limit.remaining.toString(),
        'X-RateLimit-Reset': limit.reset.toString(),
      },
    })
  }

  console.log('userID', userID)
  // console.log('template', template)
  console.log('model', model)
  // console.log('config', config)

  const { model: modelNameString, apiKey: modelApiKey, ...modelParams } = config
  const modelClient = getModelClient(model, config)
  const langgraphClient = getLangGraphClient(config)

  let stream
  if (quality === 'High') {
    // High quality
    const config = {
      configurable: {
        model: `${model.providerId}/${model.id}`,
      },
    }

    console.log('Generating response with LangGraph...')
    const streamResponse = langgraphClient.runs.stream(
      null, // Threadless run
      'agent', // Assistant ID
      {
        input: {
          messages: messages,
        },
        config: config,
        streamMode: 'values',
      },
    )

    let finalAnswer
    for await (const chunk of streamResponse) {
      finalAnswer = chunk.data
    }

    const lastMessage = finalAnswer.messages[finalAnswer.messages.length - 1]
    console.log('LangGraph response', finalAnswer)

    const addedMessages: CoreMessage[] = [
      {
        role: 'assistant',
        content: lastMessage.content,
      },
      {
        role: 'user',
        content:
          'Please structure your answer according to the given template.',
      },
    ]
    messages.push(...addedMessages)

    stream = await streamObject({
      model: modelClient as LanguageModel,
      schema,
      system: toLangGraphPrompt(template),
      messages,
      mode: getDefaultMode(model),
      ...modelParams,
    })
  } else {
    // Low quality
    stream = await streamObject({
      model: modelClient as LanguageModel,
      schema,
      system: toPrompt(template),
      messages,
      mode: getDefaultMode(model),
      ...modelParams,
    })
  }
  return stream.toTextStreamResponse()
}
