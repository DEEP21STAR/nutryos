import { describe, expect, it, vi } from 'vitest'
import { barcodeProblem, createFallbackScanner, gtinChecksumValid, normalizeBarcode, type FrameDetector } from '@/lib/barcode'

describe('gtinChecksumValid', () => {
  it('accepts real EAN-13 / EAN-8 / UPC-A numbers', () => {
    expect(gtinChecksumValid('4006381333931')).toBe(true) // Stabilo EAN-13 (GS1 example)
    expect(gtinChecksumValid('96385074')).toBe(true) // EAN-8 (GS1 example)
    expect(gtinChecksumValid('036000291452')).toBe(true) // UPC-A (GS1 example)
    expect(gtinChecksumValid('9400550006407')).toBe(true) // NZ 94-prefix
    expect(gtinChecksumValid('9415007008132')).toBe(true) // NZ 94-prefix
  })
  it('rejects a wrong check digit, bad lengths and non-digits', () => {
    expect(gtinChecksumValid('4006381333932')).toBe(false)
    expect(gtinChecksumValid('96385075')).toBe(false)
    expect(gtinChecksumValid('036000291453')).toBe(false)
    expect(gtinChecksumValid('9400550006404')).toBe(false)
    expect(gtinChecksumValid('12345')).toBe(false)
    expect(gtinChecksumValid('40063813339a1')).toBe(false)
    expect(gtinChecksumValid('')).toBe(false)
  })
})

describe('normalizeBarcode', () => {
  it('pads UPC-A to 13 digits and flags NZ 94 prefixes', () => {
    expect(normalizeBarcode('036000291452')).toEqual({ code: '0036000291452', kind: 'UPC-A', isNz: false })
    expect(normalizeBarcode('9400550006407')).toEqual({ code: '9400550006407', kind: 'EAN-13', isNz: true })
    expect(normalizeBarcode('4006381333931')?.isNz).toBe(false)
    expect(normalizeBarcode('96385074')).toEqual({ code: '96385074', kind: 'EAN-8', isNz: false })
  })
  it('tolerates spaces and dashes, rejects garbage', () => {
    expect(normalizeBarcode('94 00550 006407')?.code).toBe('9400550006407')
    expect(normalizeBarcode('9400550006404')).toBeNull()
  })
})

describe('barcodeProblem', () => {
  it('explains what is wrong', () => {
    expect(barcodeProblem('')).toBeNull()
    expect(barcodeProblem('9400550006407')).toBeNull()
    expect(barcodeProblem('94005')).toMatch(/5 digits/)
    expect(barcodeProblem('9400550006404')).toMatch(/last digit/)
    expect(barcodeProblem('94x')).toMatch(/digits only/)
  })
})

const det = (impl: () => Promise<Array<{ rawValue: string }>>): FrameDetector & { detect: ReturnType<typeof vi.fn> } => ({ detect: vi.fn(impl) })

describe('createFallbackScanner (decide by results)', () => {
  it('uses the ponyfill straight away when there is no native detector', async () => {
    const pony = det(async () => [{ rawValue: '9400550006407' }])
    const s = createFallbackScanner({ native: null, loadPonyfill: async () => pony })
    const hit = await s.scan('frame')
    expect(hit?.engine).toBe('ponyfill')
    expect(hit?.fellBack).toBe(false)
  })

  it('native present but returns [] -> ponyfill decodes after N empty frames', async () => {
    const native = det(async () => [])
    const pony = det(async () => [{ rawValue: '9400550006407' }])
    const load = vi.fn(async () => pony)
    const s = createFallbackScanner({ native, loadPonyfill: load, fallbackAfterEmptyFrames: 3 })
    expect(await s.scan('f1')).toBeNull()
    expect(await s.scan('f2')).toBeNull()
    expect(load).not.toHaveBeenCalled() // ponyfill is not even loaded while native is still getting a chance
    const hit = await s.scan('f3')
    expect(hit).toMatchObject({ engine: 'ponyfill', fellBack: true })
    expect(hit?.barcode.code).toBe('9400550006407')
    expect(native.detect).toHaveBeenCalledTimes(3)
  })

  it('a still photo (N=1) falls back on the first empty result', async () => {
    const s = createFallbackScanner({
      native: det(async () => []),
      loadPonyfill: async () => det(async () => [{ rawValue: '036000291452' }]),
      fallbackAfterEmptyFrames: 1,
    })
    expect((await s.scan('img'))?.barcode.code).toBe('0036000291452')
  })

  it('native returning a wrong-checksum string counts as a miss, not a hit', async () => {
    const s = createFallbackScanner({
      native: det(async () => [{ rawValue: '9400550006404' }]),
      loadPonyfill: async () => det(async () => [{ rawValue: '9400550006407' }]),
      fallbackAfterEmptyFrames: 1,
    })
    expect((await s.scan('img'))).toMatchObject({ engine: 'ponyfill', barcode: { code: '9400550006407' } })
  })

  it('native that never resolves times out and is switched off after 2 timeouts', async () => {
    const native = det(() => new Promise(() => {}))
    const pony = det(async () => [{ rawValue: '9400550006407' }])
    const s = createFallbackScanner({ native, loadPonyfill: async () => pony, nativeTimeoutMs: 20, nativeMaxTimeouts: 2, fallbackAfterEmptyFrames: 99 })
    expect(await s.scan('f1')).toBeNull() // timeout 1, below the miss threshold
    const hit = await s.scan('f2') // timeout 2 -> native switched off -> ponyfill
    expect(hit?.engine).toBe('ponyfill')
    expect(s.state().nativeAlive).toBe(false)
    await s.scan('f3')
    expect(native.detect).toHaveBeenCalledTimes(2) // not asked again
  })

  it('native that throws is tolerated and falls back', async () => {
    const s = createFallbackScanner({
      native: det(async () => {
        throw new Error('InvalidStateError')
      }),
      loadPonyfill: async () => det(async () => [{ rawValue: '96385074' }]),
      fallbackAfterEmptyFrames: 1,
    })
    expect((await s.scan('x'))?.barcode.kind).toBe('EAN-8')
  })

  it('native hit wins and never loads the ponyfill', async () => {
    const load = vi.fn(async () => det(async () => []))
    const s = createFallbackScanner({ native: det(async () => [{ rawValue: '9400550006407' }]), loadPonyfill: load })
    expect((await s.scan('x'))?.engine).toBe('native')
    expect(load).not.toHaveBeenCalled()
  })

  it('returns null (never a fake code) when neither engine finds anything', async () => {
    const s = createFallbackScanner({ native: det(async () => []), loadPonyfill: async () => det(async () => []), fallbackAfterEmptyFrames: 1 })
    expect(await s.scan('x')).toBeNull()
  })
})
