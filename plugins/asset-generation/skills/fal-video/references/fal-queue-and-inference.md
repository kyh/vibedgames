# fal Queue And Inference Notes

## Queue Endpoints

From the official Queue API docs:

- `POST https://queue.fal.run/{model_id}`
- `POST https://queue.fal.run/{model_id}/{subpath}`
- `GET https://queue.fal.run/{model_id}/requests/{request_id}/status`
- `GET https://queue.fal.run/{model_id}/requests/{request_id}`
- `PUT https://queue.fal.run/{model_id}/requests/{request_id}/cancel`

Docs:

- https://docs.fal.ai/model-apis/model-endpoints/queue

## Status Lifecycle

Documented queue statuses:

- `IN_QUEUE`
- `IN_PROGRESS`
- `COMPLETED`

Practical rule:

- treat `COMPLETED` as “result endpoint is now the source of truth”
- still inspect the returned payload for model-level errors

## Logs

Logs are disabled by default.

To include logs when polling status with raw HTTP:

- add `?logs=1`

## Result Handling

The result endpoint returns the model payload as JSON.

For video models, that usually includes:

- `video.url`

But the skill should not hard-code that as the only possible output shape. Walk the payload recursively and collect file URLs so new models remain usable without rewriting the downloader first.

## Failure Handling

fal documents these important behaviors:

- long-running requests belong on the queue
- requests may be automatically re-queued by fal on infrastructure failures
- 5xx infrastructure errors are not billed

Practical repo rule:

- always write request JSON, status snapshots, and final result JSON even if the run fails
- a failed run is still useful evidence for model comparison

