const nonce = process.argv[2]
process.on('message', (request) => {
  process.send({ kind: 'step', nonce, requestId: request.requestId, name: 'thumbnail' })
  if (request.source === 'crash') process.exit(2)
  if (request.source === 'hang') {
    for (;;) {
      /* Deliberately block the owned child. */
    }
  }
  const started = performance.now()
  if (request.source === 'stall') {
    while (performance.now() - started < 500) {
      /* Simulate blocking native Shell work. */
    }
  }
  if (request.source === 'disconnect') {
    process.disconnect()
    return
  }
  process.send({
    kind: 'result',
    nonce,
    requestId: request.requestId,
    bytes: request.source === 'invalid' ? 'not-a-buffer' : Buffer.from('unchanged-thumbnail'),
    outcome: 'ready',
    durations: { thumbnail: performance.now() - started, icon: 0.1 },
  })
})
process.on('disconnect', () => process.exit(0))
process.send({ kind: 'ready', nonce })
