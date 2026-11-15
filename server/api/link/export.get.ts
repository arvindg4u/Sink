defineRouteMeta({
  openAPI: {
    description: 'Export all links with pagination',
    security: [{ bearerAuth: [] }],
    parameters: [
      {
        name: 'cursor',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Pagination cursor from previous response',
      },
      {
        name: 'status',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['active', 'expired', 'all'], default: 'all' },
        description: 'Expiration status filter',
      },
    ],
  },
})

export default eventHandler(async (event) => {
  const query = await getValidatedQuery(event, ExportLinksQuerySchema.parse)

  const exportData = await bulkExportLinks(event, query)

  setResponseHeader(event, 'Content-Type', 'application/json')
  setResponseHeader(event, 'Cache-Control', 'no-store')

  return exportData
})
