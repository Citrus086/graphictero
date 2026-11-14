import { describe, expect, it } from 'vitest'
import {
  MATH_EXPR_MAX_DEPTH,
  MATH_EXPR_MAX_LENGTH,
  MATH_FUNCTION_NAMES,
  MathExprError,
  compileMathExpression,
  evaluateMathExpression
} from './mathExpr'

describe('mathExpr 算术、优先级与数字', () => {
  it('支持四则运算、括号、左结合与一元正负号', () => {
    expect(evaluateMathExpression('1 + 2 * 3')).toBe(7)
    expect(evaluateMathExpression('(1 + 2) * 3')).toBe(9)
    expect(evaluateMathExpression('10 - 3 - 2')).toBe(5)
    expect(evaluateMathExpression('20 / 5 / 2')).toBe(2)
    expect(evaluateMathExpression('-2 + +3')).toBe(1)
    expect(evaluateMathExpression('--2')).toBe(2)
    expect(evaluateMathExpression('2 * -3')).toBe(-6)
  })

  it('幂右结合、高于一元负号，同时允许负指数', () => {
    expect(evaluateMathExpression('2^3^2')).toBe(512)
    expect(evaluateMathExpression('-2^2')).toBe(-4)
    expect(evaluateMathExpression('(-2)^2')).toBe(4)
    expect(evaluateMathExpression('2^-2')).toBe(0.25)
    expect(evaluateMathExpression('-2^-2')).toBe(-0.25)
    expect(evaluateMathExpression('2 * 3^2')).toBe(18)
  })

  it('支持小数、前导/尾随小数点与科学计数法', () => {
    expect(evaluateMathExpression('.5 + 1.')).toBe(1.5)
    expect(evaluateMathExpression('1e3 + 1.2e-2 + 2E+2')).toBeCloseTo(1200.012)
    expect(() => evaluateMathExpression('1e')).toThrow(MathExprError)
  })
})

describe('mathExpr 比较与三元表达式', () => {
  it('六种比较均返回 1 或 0', () => {
    expect(evaluateMathExpression('1 < 2')).toBe(1)
    expect(evaluateMathExpression('2 < 1')).toBe(0)
    expect(evaluateMathExpression('2 <= 2')).toBe(1)
    expect(evaluateMathExpression('3 > 2')).toBe(1)
    expect(evaluateMathExpression('2 >= 3')).toBe(0)
    expect(evaluateMathExpression('1 == 1')).toBe(1)
    expect(evaluateMathExpression('1 != 1')).toBe(0)
    expect(evaluateMathExpression('1 + 2 * 3 == 7')).toBe(1)
  })

  it('三元按条件选择，支持嵌套与比较条件', () => {
    expect(evaluateMathExpression('1 < 2 ? 10 : 20')).toBe(10)
    expect(evaluateMathExpression('0 ? 10 : 20')).toBe(20)
    expect(evaluateMathExpression('0 ? 1 : 1 ? 2 : 3')).toBe(2)
    expect(evaluateMathExpression('1 ? 0 ? 2 : 3 : 4')).toBe(3)
    expect(evaluateMathExpression('1 ? 2 : missing')).toBe(2)
  })
})

describe('mathExpr 函数、常量与变量', () => {
  it('公开固定函数白名单与限制常量', () => {
    expect(MATH_EXPR_MAX_LENGTH).toBe(300)
    expect(MATH_EXPR_MAX_DEPTH).toBe(64)
    expect(MATH_FUNCTION_NAMES).toEqual([
      'sin', 'cos', 'tan', 'exp', 'log', 'ln', 'sqrt', 'abs',
      'min', 'max', 'pow', 'floor', 'ceil', 'round'
    ])
    expect(Object.isFrozen(MATH_FUNCTION_NAMES)).toBe(true)
  })

  it('支持全部白名单函数，log 为 log10、ln 为自然对数', () => {
    expect(evaluateMathExpression('sin(0)')).toBe(0)
    expect(evaluateMathExpression('cos(0)')).toBe(1)
    expect(evaluateMathExpression('tan(0)')).toBe(0)
    expect(evaluateMathExpression('exp(1)')).toBeCloseTo(Math.E)
    expect(evaluateMathExpression('log(100)')).toBe(2)
    expect(evaluateMathExpression('ln(e)')).toBe(1)
    expect(evaluateMathExpression('sqrt(9) + abs(-3)')).toBe(6)
    expect(evaluateMathExpression('min(3, 1, 2)')).toBe(1)
    expect(evaluateMathExpression('max(3, 1, 2)')).toBe(3)
    expect(evaluateMathExpression('pow(2, 3)')).toBe(8)
    expect(evaluateMathExpression('floor(1.9) + ceil(1.1) + round(1.5)')).toBe(5)
  })

  it('识别 pi/e，变量按首次引用顺序去重且不包含常量', () => {
    expect(evaluateMathExpression('pi')).toBeCloseTo(Math.PI)
    expect(evaluateMathExpression('e')).toBeCloseTo(Math.E)
    const compiled = compileMathExpression('x + y + x + pi + e')
    expect(compiled.source).toBe('x + y + x + pi + e')
    expect(compiled.variables).toEqual(['x', 'y'])
    expect(Object.isFrozen(compiled.variables)).toBe(true)
  })

  it('编译后缓存 AST，多次 evaluate 只替换变量值', () => {
    const compiled = compileMathExpression('x^2 + y')
    expect(compiled.evaluate(new Map([['x', 2], ['y', 1]]))).toBe(5)
    expect(compiled.evaluate(new Map([['x', 3], ['y', 4]]))).toBe(13)
    expect(compiled.evaluate(new Map([['x', -2], ['y', 10]]))).toBe(14)
  })

  it('检查固定与可变参数 arity，并拒绝未知函数', () => {
    for (const source of ['sin()', 'sin(1, 2)', 'pow(1)', 'pow(1, 2, 3)', 'min()', 'max()']) {
      expect(() => compileMathExpression(source)).toThrow(MathExprError)
    }
    expect(() => compileMathExpression('foo(1)')).toThrow(MathExprError)
    expect(() => compileMathExpression('random(1)')).toThrow(MathExprError)
  })

  it('未知变量抛 MathExprError，未选中的三元分支不求值', () => {
    expect(() => evaluateMathExpression('x + 1')).toThrow(MathExprError)
    expect(() => evaluateMathExpression('x + 1', new Map([['y', 2]]))).toThrow(MathExprError)
    expect(evaluateMathExpression('0 ? missing : 7')).toBe(7)
  })
})

describe('mathExpr 非有限数与数学定义域', () => {
  it('除零、无效定义域与幂按 JavaScript 数学语义返回非有限数', () => {
    expect(evaluateMathExpression('1 / 0')).toBe(Infinity)
    expect(evaluateMathExpression('-1 / 0')).toBe(-Infinity)
    expect(evaluateMathExpression('0 / 0')).toBeNaN()
    expect(evaluateMathExpression('sqrt(-1)')).toBeNaN()
    expect(evaluateMathExpression('log(0)')).toBe(-Infinity)
    expect(evaluateMathExpression('0^-1')).toBe(Infinity)
    expect(evaluateMathExpression('1e309')).toBe(Infinity)
  })
})

describe('mathExpr 安全限制与语法错误', () => {
  it('危险名称即使存在于 Map 也始终作为未知变量报错', () => {
    for (const name of ['constructor', '__proto__', 'process', 'globalThis', 'prototype']) {
      expect(() => evaluateMathExpression(name, new Map([[name, 42]]))).toThrow(MathExprError)
    }
  })

  it('拒绝属性访问、方括号、字符串、赋值、分号与原型路径', () => {
    const sources = [
      'a.b',
      'x[0]',
      '"str"',
      "'str'",
      '1;2',
      'x = 1',
      'sin.call',
      'sin["call"]',
      'constructor.prototype',
      '__proto__.constructor',
      'globalThis.process',
      'new Function("return 1")'
    ]
    for (const source of sources) {
      expect(() => compileMathExpression(source)).toThrow(MathExprError)
    }
  })

  it('拒绝空表达式、不完整运算、括号/三元与参数列表错误', () => {
    const sources = ['', '   ', '1 2', '(1', '1)', '1 +', '1 ? 2', '1 ? 2 :', 'pow(2 3)', '1e']
    for (const source of sources) {
      expect(() => compileMathExpression(source)).toThrow(MathExprError)
    }
  })

  it('超长表达式在解析前被拒绝', () => {
    expect(() => compileMathExpression('1'.repeat(MATH_EXPR_MAX_LENGTH + 1))).toThrow(MathExprError)
  })

  it('token 数有独立上限', () => {
    const source = `${'1+'.repeat(130)}1`
    expect(source.length).toBeLessThanOrEqual(MATH_EXPR_MAX_LENGTH)
    expect(() => compileMathExpression(source)).toThrow(MathExprError)
  })

  it('深括号、深一元链与深 AST 均报 MathExprError 而非栈溢出', () => {
    const parentheses = `${'('.repeat(100)}1${')'.repeat(100)}`
    expect(() => compileMathExpression(parentheses)).toThrow(MathExprError)
    expect(() => compileMathExpression('-'.repeat(100) + '1')).toThrow(MathExprError)
    expect(() => compileMathExpression(Array.from({ length: 70 }, () => '1').join('+'))).toThrow(MathExprError)
  })
})
