import { z } from 'zod'

defineRouteMeta({
  openAPI: {
    description: 'Generate a slug using AI based on the URL',
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: 'url',
        in: 'query',
        required: true,
        schema: { type: 'string', format: 'uri' },
        description: 'The URL to generate a slug for',
      },
    ],
  },
})

export default eventHandler(async (event) => {
  const url = (await getValidatedQuery(event, z.object({
    url: z.url(),
  }).parse)).url

  return generateLinkSlug(event, url)
})
