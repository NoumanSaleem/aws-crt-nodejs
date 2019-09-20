/*
 * Copyright 2010-2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 *  http://aws.amazon.com/apache2.0
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

#include "uv_interop.h"
#include <aws/common/common.h>
#include <aws/common/mutex.h>
#include <aws/io/message_pool.h>

#include <uv.h>

struct aws_uv_context {
    uv_loop_t *uv_loop;
    napi_env env;
    uv_async_t async_handle;
    struct aws_allocator *allocator;
    struct {
        struct aws_mutex mutex;
        struct aws_memory_pool pool;
    } command_pool;

    struct {
        struct aws_mutex mutex;
        struct aws_linked_list queue;
    } command_queue;
};

struct aws_uv_callback {
    struct aws_linked_list_node list_node;
    aws_uv_callback_fn *callback;
    void *user_data;
};

static struct aws_uv_callback *s_uv_command_alloc(struct aws_uv_context *ctx) {
    aws_mutex_lock(&ctx->command_pool.mutex);
    struct aws_uv_callback *callback = aws_memory_pool_acquire(&ctx->command_pool.pool);
    aws_mutex_unlock(&ctx->command_pool.mutex);

    AWS_ZERO_STRUCT(*callback);
    return callback;
}

static void s_uv_command_free(struct aws_uv_context *ctx, struct aws_uv_callback *callback) {
    aws_mutex_lock(&ctx->command_pool.mutex);
    aws_memory_pool_release(&ctx->command_pool.pool, callback);
    aws_mutex_unlock(&ctx->command_pool.mutex);
}

/* gets called inside the libuv event loop when we notify the async handle */
static void s_uv_dispatch_pump(uv_async_t *handle) {
    struct aws_uv_context *ctx = handle->data;
    struct aws_linked_list commands;
    aws_linked_list_init(&commands);

    aws_mutex_lock(&ctx->command_queue.mutex);
    aws_linked_list_swap_contents(&commands, &ctx->command_queue.queue);
    aws_mutex_unlock(&ctx->command_queue.mutex);

    while (!aws_linked_list_empty(&commands)) {
        struct aws_linked_list_node *list_node = aws_linked_list_pop_front(&commands);
        struct aws_uv_callback *callback = AWS_CONTAINER_OF(list_node, struct aws_uv_callback, list_node);
        callback->callback(callback->user_data);
        s_uv_command_free(ctx, callback);
    }
}

struct aws_uv_context *aws_uv_context_new(napi_env env, struct aws_allocator *allocator) {
    struct aws_uv_context *ctx = aws_mem_calloc(allocator, 1, sizeof(struct aws_uv_context));
    AWS_FATAL_ASSERT(ctx);

    ctx->allocator = allocator;

    aws_mutex_init(&ctx->command_queue.mutex);
    aws_linked_list_init(&ctx->command_queue.queue);
    aws_mutex_init(&ctx->command_pool.mutex);
    aws_memory_pool_init(&ctx->command_pool.pool, allocator, 16, sizeof(struct aws_uv_callback));

    napi_get_uv_event_loop(env, &ctx->uv_loop);
    AWS_FATAL_ASSERT(ctx->uv_loop);

    uv_async_init(ctx->uv_loop, &ctx->async_handle, s_uv_dispatch_pump);
    ctx->env = env;
    ctx->async_handle.data = ctx;

    return ctx;
}

static void s_uv_closed(uv_handle_t *handle) {
    struct aws_uv_context *ctx = handle->data;

    /* finish the rest of cleanup */
    aws_memory_pool_clean_up(&ctx->command_pool.pool);
    aws_mutex_clean_up(&ctx->command_queue.mutex);
    aws_mutex_clean_up(&ctx->command_pool.mutex);
    aws_mem_release(ctx->allocator, ctx);
}

void aws_uv_context_release(struct aws_uv_context *ctx) {
    aws_mutex_lock(&ctx->command_queue.mutex);
    /* For now, don't bother supporting a final flush, it shouldn't be necessary, as when refs are
       dropped the owning object should be on its way to death */
    AWS_ASSERT(aws_linked_list_empty(&ctx->command_queue.queue));
    aws_mutex_unlock(&ctx->command_queue.mutex);

    /* close uv handle, when it's dead, we finish cleanup in the callback */
    uv_close((uv_handle_t *)&ctx->async_handle, s_uv_closed);
}

void aws_uv_context_enqueue(struct aws_uv_context *ctx, aws_uv_callback_fn *callback, void *user_data) {
    AWS_FATAL_ASSERT(ctx && ctx->uv_loop);

    struct aws_uv_callback *cb = s_uv_command_alloc(ctx);
    cb->callback = callback;
    cb->user_data = user_data;
    aws_mutex_lock(&ctx->command_queue.mutex);
    aws_linked_list_push_back(&ctx->command_queue.queue, &cb->list_node);
    aws_mutex_unlock(&ctx->command_queue.mutex);

    /* notify uv that there's work to do */
    uv_async_send(&ctx->async_handle);
}