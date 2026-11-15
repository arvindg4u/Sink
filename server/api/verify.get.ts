defineRouteMeta({
  openAPI: {
    description: 'Verify the current authentication method',
    responses: {
      200: {
        description: 'The authentication credentials are valid',
      },
      default: {
        description: 'The authentication credentials are invalid',
      },
    },
  },
})

export default eventHandler(event => buildVerificationResponse(event))
