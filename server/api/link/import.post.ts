import { ImportDataSchema } from '#shared/schemas/import'

defineRouteMeta({
  openAPI: {
    description: 'Import links from exported data',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: { 'application/json': {} },
    },
  },
})

export default eventHandler(async (event) => {
  const importData = await readValidatedBody(event, ImportDataSchema.parse)

  const result = await bulkImportLinks(event, importData)

  setResponseHeader(event, 'Cache-Control', 'no-store')

  return result
})
