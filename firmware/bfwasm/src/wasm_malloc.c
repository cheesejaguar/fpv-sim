/*
 * fpv-sim Betaflight WASM target: minimal heap allocator (-sMALLOC=none).
 * GPL-3.0-or-later.
 *
 * Why not dlmalloc/emmalloc: a firmware reboot restores ALL static data
 * (.data/.bss) from a power-on snapshot (see wasm_api.c). A normal allocator
 * keeps its state in .bss and would "forget" blocks the JS host malloc()ed
 * after boot, handing them out twice. This allocator keeps its only state in
 * the first bytes of the heap itself (above __heap_base), outside the
 * snapshot, so it is unaffected by reboots.
 *
 * Betaflight itself never allocates; the host allocates a few small scratch
 * buffers. Blocks carry a size header; free() puts blocks on a single free
 * list (first fit), which is plenty for this workload.
 */

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>

#include <emscripten/heap.h>

#define ALIGN 16u
#define HEADER 16u
#define STATE_MAGIC 0x42465741u  // 'BFWA'

typedef struct freeBlock_s {
    size_t size;                // payload size
    struct freeBlock_s *next;
} freeBlock_t;

typedef struct heapState_s {
    uint32_t magic;
    uintptr_t top;              // next unallocated byte
    freeBlock_t *freeList;
} heapState_t;

extern unsigned char __heap_base;

static inline uintptr_t alignUp(uintptr_t v, uintptr_t a)
{
    return (v + a - 1) & ~(a - 1);
}

static heapState_t *heapState(void)
{
    heapState_t *s = (heapState_t *)alignUp((uintptr_t)&__heap_base, ALIGN);
    if (s->magic != STATE_MAGIC) {
        s->magic = STATE_MAGIC;
        s->top = alignUp((uintptr_t)s + sizeof(heapState_t), ALIGN);
        s->freeList = NULL;
    }
    return s;
}

static int ensureMemory(uintptr_t end)
{
    const size_t have = emscripten_get_heap_size();
    if (end <= have) {
        return 1;
    }
    return emscripten_resize_heap(end);
}

void *malloc(size_t size)
{
    if (size == 0) {
        size = 1;
    }
    size = alignUp(size, ALIGN);
    heapState_t *s = heapState();

    // first fit from the free list
    freeBlock_t **link = &s->freeList;
    for (freeBlock_t *b = s->freeList; b; link = &b->next, b = b->next) {
        if (b->size >= size) {
            *link = b->next;
            return (unsigned char *)b + HEADER;
        }
    }

    const uintptr_t block = s->top;
    const uintptr_t end = block + HEADER + size;
    if (!ensureMemory(end)) {
        errno = ENOMEM;
        return NULL;
    }
    s->top = end;
    ((freeBlock_t *)block)->size = size;
    return (void *)(block + HEADER);
}

void free(void *ptr)
{
    if (!ptr) {
        return;
    }
    heapState_t *s = heapState();
    freeBlock_t *b = (freeBlock_t *)((unsigned char *)ptr - HEADER);
    b->next = s->freeList;
    s->freeList = b;
}

void *calloc(size_t n, size_t size)
{
    if (size && n > SIZE_MAX / size) {
        errno = ENOMEM;
        return NULL;
    }
    void *p = malloc(n * size);
    if (p) {
        memset(p, 0, n * size);
    }
    return p;
}

void *realloc(void *ptr, size_t size)
{
    if (!ptr) {
        return malloc(size);
    }
    if (size == 0) {
        free(ptr);
        return NULL;
    }
    freeBlock_t *b = (freeBlock_t *)((unsigned char *)ptr - HEADER);
    if (b->size >= size) {
        return ptr;
    }
    void *n = malloc(size);
    if (n) {
        memcpy(n, ptr, b->size);
        free(ptr);
    }
    return n;
}

void *memalign(size_t alignment, size_t size)
{
    if (alignment <= ALIGN) {
        return malloc(size);
    }
    // over-allocate; the wasted head is never returned to the free list
    unsigned char *raw = malloc(size + alignment);
    if (!raw) {
        return NULL;
    }
    uintptr_t p = alignUp((uintptr_t)raw, alignment);
    if (p != (uintptr_t)raw) {
        // give the aligned pointer its own header so free() works
        freeBlock_t *b = (freeBlock_t *)(p - HEADER);
        b->size = size;
    }
    return (void *)p;
}

void *aligned_alloc(size_t alignment, size_t size)
{
    return memalign(alignment, size);
}

int posix_memalign(void **memptr, size_t alignment, size_t size)
{
    void *p = memalign(alignment, size);
    if (!p) {
        return ENOMEM;
    }
    *memptr = p;
    return 0;
}

size_t malloc_usable_size(void *ptr)
{
    if (!ptr) {
        return 0;
    }
    return ((freeBlock_t *)((unsigned char *)ptr - HEADER))->size;
}
