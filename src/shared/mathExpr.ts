export const MATH_EXPR_MAX_LENGTH = 300
export const MATH_EXPR_MAX_DEPTH = 64

export const MATH_FUNCTION_NAMES = Object.freeze([
  'sin',
  'cos',
  'tan',
  'exp',
  'log',
  'ln',
  'sqrt',
  'abs',
  'min',
  'max',
  'pow',
  'floor',
  'ceil',
  'round'
] as const)

type MathFunctionName = (typeof MATH_FUNCTION_NAMES)[number]

export class MathExprError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MathExprError'
  }
}

export interface CompiledMathExpression {
  readonly source: string
  readonly variables: readonly string[]
  evaluate(values: ReadonlyMap<string, number>): number
}

type UnaryOperator = '+' | '-'
type BinaryOperator = '+' | '-' | '*' | '/' | '^' | '<' | '<=' | '>' | '>=' | '==' | '!='

type AstNode =
  | { kind: 'number'; value: number; depth: number }
  | { kind: 'variable'; name: string; depth: number }
  | { kind: 'unary'; operator: UnaryOperator; operand: AstNode; depth: number }
  | { kind: 'binary'; operator: BinaryOperator; left: AstNode; right: AstNode; depth: number }
  | { kind: 'conditional'; condition: AstNode; whenTrue: AstNode; whenFalse: AstNode; depth: number }
  | { kind: 'call'; name: MathFunctionName; args: readonly AstNode[]; depth: number }

type MathSymbol =
  | '('
  | ')'
  | ','
  | '+'
  | '-'
  | '*'
  | '/'
  | '^'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '?'
  | ':'

type Token =
  | { kind: 'number'; value: number; position: number }
  | { kind: 'identifier'; name: string; position: number }
  | { kind: 'symbol'; symbol: MathSymbol; position: number }
  | { kind: 'end'; position: number }

const MATH_EXPR_MAX_TOKENS = 256
const MATH_FUNCTION_NAME_SET: ReadonlySet<string> = new Set(MATH_FUNCTION_NAMES)
export const MATH_FORBIDDEN_VARIABLE_NAMES = Object.freeze([
  'constructor',
  '__proto__',
  'prototype',
  'process',
  'globalThis',
  'global',
  'window',
  'self',
  'this',
  'Function',
  'eval',
  'require',
  'module',
  'exports'
] as const)
const FORBIDDEN_VARIABLE_NAMES: ReadonlySet<string> = new Set(MATH_FORBIDDEN_VARIABLE_NAMES)
const SINGLE_SYMBOLS: ReadonlySet<string> = new Set([
  '(',
  ')',
  ',',
  '+',
  '-',
  '*',
  '/',
  '^',
  '<',
  '>',
  '?',
  ':'
])

function errorAt(message: string, position: number): MathExprError {
  return new MathExprError(`${message}（位置 ${position + 1}）`)
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}

function isIdentifierStart(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_'
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || isDigit(char)
}

function isMathSymbol(char: string): char is MathSymbol {
  return SINGLE_SYMBOLS.has(char)
}

function isMathFunctionName(name: string): name is MathFunctionName {
  return MATH_FUNCTION_NAME_SET.has(name)
}

function pushToken(tokens: Token[], token: Token): void {
  if (tokens.length >= MATH_EXPR_MAX_TOKENS) {
    throw errorAt(`表达式 token 数不能超过 ${MATH_EXPR_MAX_TOKENS}`, token.position)
  }
  tokens.push(token)
}

function lex(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < source.length) {
    const char = source[index]!
    if (/\s/.test(char)) {
      index += 1
      continue
    }

    if (isDigit(char) || (char === '.' && isDigit(source[index + 1] ?? ''))) {
      const start = index
      while (isDigit(source[index] ?? '')) index += 1
      if (source[index] === '.') {
        index += 1
        while (isDigit(source[index] ?? '')) index += 1
      }
      if (source[index] === 'e' || source[index] === 'E') {
        index += 1
        if (source[index] === '+' || source[index] === '-') index += 1
        const exponentStart = index
        while (isDigit(source[index] ?? '')) index += 1
        if (index === exponentStart) throw errorAt('科学计数法缺少指数数字', start)
      }
      const value = Number(source.slice(start, index))
      if (Number.isNaN(value)) throw errorAt('无效数字', start)
      pushToken(tokens, { kind: 'number', value, position: start })
      continue
    }

    if (isIdentifierStart(char)) {
      const start = index
      index += 1
      while (isIdentifierPart(source[index] ?? '')) index += 1
      pushToken(tokens, { kind: 'identifier', name: source.slice(start, index), position: start })
      continue
    }

    const pair = source.slice(index, index + 2)
    if (pair === '<=' || pair === '>=' || pair === '==' || pair === '!=') {
      pushToken(tokens, { kind: 'symbol', symbol: pair, position: index })
      index += 2
      continue
    }
    if (isMathSymbol(char)) {
      pushToken(tokens, { kind: 'symbol', symbol: char, position: index })
      index += 1
      continue
    }
    throw errorAt('表达式含禁止或无法识别的字符', index)
  }

  tokens.push({ kind: 'end', position: source.length })
  return tokens
}

function assertParserDepth(depth: number, position: number): void {
  if (depth > MATH_EXPR_MAX_DEPTH) {
    throw errorAt(`表达式嵌套深度不能超过 ${MATH_EXPR_MAX_DEPTH}`, position)
  }
}

function assertAstDepth(depth: number, position: number): void {
  if (depth > MATH_EXPR_MAX_DEPTH) {
    throw errorAt(`表达式 AST 深度不能超过 ${MATH_EXPR_MAX_DEPTH}`, position)
  }
}

class Parser {
  private index = 0
  private readonly variableNames = new Set<string>()

  constructor(private readonly tokens: Token[]) {}

  parse(): { ast: AstNode; variables: readonly string[] } {
    const ast = this.parseExpression(0)
    const token = this.peek()
    if (token.kind !== 'end') throw errorAt('表达式存在多余内容', token.position)
    return { ast, variables: Object.freeze(Array.from(this.variableNames)) }
  }

  private peek(): Token {
    return this.tokens[this.index]!
  }

  private consumeSymbol(symbol: MathSymbol): boolean {
    const token = this.peek()
    if (token.kind !== 'symbol' || token.symbol !== symbol) return false
    this.index += 1
    return true
  }

  private expectSymbol(symbol: MathSymbol): void {
    if (this.consumeSymbol(symbol)) return
    throw errorAt(`缺少「${symbol}」`, this.peek().position)
  }

  private makeUnary(operator: UnaryOperator, operand: AstNode, position: number): AstNode {
    const depth = operand.depth + 1
    assertAstDepth(depth, position)
    return { kind: 'unary', operator, operand, depth }
  }

  private makeBinary(
    operator: BinaryOperator,
    left: AstNode,
    right: AstNode,
    position: number
  ): AstNode {
    const depth = Math.max(left.depth, right.depth) + 1
    assertAstDepth(depth, position)
    return { kind: 'binary', operator, left, right, depth }
  }

  private parseExpression(depth: number): AstNode {
    assertParserDepth(depth, this.peek().position)
    const condition = this.parseComparison(depth)
    if (!this.consumeSymbol('?')) return condition

    const whenTrue = this.parseExpression(depth + 1)
    this.expectSymbol(':')
    const whenFalse = this.parseExpression(depth + 1)
    const astDepth = Math.max(condition.depth, whenTrue.depth, whenFalse.depth) + 1
    assertAstDepth(astDepth, this.peek().position)
    return { kind: 'conditional', condition, whenTrue, whenFalse, depth: astDepth }
  }

  private parseComparison(depth: number): AstNode {
    let left = this.parseAdditive(depth)
    while (true) {
      const token = this.peek()
      if (token.kind !== 'symbol') break
      const operator = token.symbol
      if (operator !== '<' && operator !== '<=' && operator !== '>' && operator !== '>=' &&
        operator !== '==' && operator !== '!=') break
      this.index += 1
      const right = this.parseAdditive(depth)
      left = this.makeBinary(operator, left, right, token.position)
    }
    return left
  }

  private parseAdditive(depth: number): AstNode {
    let left = this.parseMultiplicative(depth)
    while (true) {
      const token = this.peek()
      if (token.kind !== 'symbol' || (token.symbol !== '+' && token.symbol !== '-')) break
      this.index += 1
      const right = this.parseMultiplicative(depth)
      left = this.makeBinary(token.symbol, left, right, token.position)
    }
    return left
  }

  private parseMultiplicative(depth: number): AstNode {
    let left = this.parseUnary(depth)
    while (true) {
      const token = this.peek()
      if (token.kind !== 'symbol' || (token.symbol !== '*' && token.symbol !== '/')) break
      this.index += 1
      const right = this.parseUnary(depth)
      left = this.makeBinary(token.symbol, left, right, token.position)
    }
    return left
  }

  private parseUnary(depth: number): AstNode {
    assertParserDepth(depth, this.peek().position)
    const token = this.peek()
    if (token.kind === 'symbol' && (token.symbol === '+' || token.symbol === '-')) {
      this.index += 1
      return this.makeUnary(token.symbol, this.parseUnary(depth + 1), token.position)
    }
    return this.parsePower(depth)
  }

  private parsePower(depth: number): AstNode {
    const left = this.parsePrimary(depth)
    const token = this.peek()
    if (token.kind !== 'symbol' || token.symbol !== '^') return left
    this.index += 1
    const right = this.parseUnary(depth + 1)
    return this.makeBinary('^', left, right, token.position)
  }

  private parsePrimary(depth: number): AstNode {
    assertParserDepth(depth, this.peek().position)
    const token = this.peek()

    if (token.kind === 'number') {
      this.index += 1
      return { kind: 'number', value: token.value, depth: 1 }
    }

    if (token.kind === 'identifier') {
      this.index += 1
      if (this.consumeSymbol('(')) return this.parseCall(token.name, token.position, depth)
      if (token.name === 'pi') return { kind: 'number', value: Math.PI, depth: 1 }
      if (token.name === 'e') return { kind: 'number', value: Math.E, depth: 1 }
      this.variableNames.add(token.name)
      return { kind: 'variable', name: token.name, depth: 1 }
    }

    if (token.kind === 'symbol' && token.symbol === '(') {
      this.index += 1
      const expression = this.parseExpression(depth + 1)
      this.expectSymbol(')')
      return expression
    }
    throw errorAt('此处需要数字、变量、函数或括号表达式', token.position)
  }

  private parseCall(name: string, position: number, depth: number): AstNode {
    if (!isMathFunctionName(name)) throw errorAt(`未知函数「${name}」`, position)
    const args: AstNode[] = []
    if (!this.consumeSymbol(')')) {
      while (true) {
        args.push(this.parseExpression(depth + 1))
        if (this.consumeSymbol(')')) break
        this.expectSymbol(',')
      }
    }
    assertFunctionArity(name, args.length, position)
    const astDepth = args.reduce((max, arg) => Math.max(max, arg.depth), 0) + 1
    assertAstDepth(astDepth, position)
    return { kind: 'call', name, args, depth: astDepth }
  }
}

function assertFunctionArity(name: MathFunctionName, count: number, position: number): void {
  if (name === 'min' || name === 'max') {
    if (count < 1) throw errorAt(`${name} 至少需要一个参数`, position)
    return
  }
  const expected = name === 'pow' ? 2 : 1
  if (count !== expected) throw errorAt(`${name} 需要 ${expected} 个参数`, position)
}

function evaluateCall(name: MathFunctionName, args: readonly AstNode[], values: ReadonlyMap<string, number>): number {
  if (name === 'min' || name === 'max') {
    let result = evaluateAst(args[0]!, values)
    for (let index = 1; index < args.length; index += 1) {
      const value = evaluateAst(args[index]!, values)
      result = name === 'min' ? Math.min(result, value) : Math.max(result, value)
    }
    return result
  }

  const first = evaluateAst(args[0]!, values)
  switch (name) {
    case 'sin': return Math.sin(first)
    case 'cos': return Math.cos(first)
    case 'tan': return Math.tan(first)
    case 'exp': return Math.exp(first)
    case 'log': return Math.log10(first)
    case 'ln': return Math.log(first)
    case 'sqrt': return Math.sqrt(first)
    case 'abs': return Math.abs(first)
    case 'pow': return Math.pow(first, evaluateAst(args[1]!, values))
    case 'floor': return Math.floor(first)
    case 'ceil': return Math.ceil(first)
    case 'round': return Math.round(first)
  }
}

function evaluateAst(node: AstNode, values: ReadonlyMap<string, number>): number {
  switch (node.kind) {
    case 'number':
      return node.value
    case 'variable': {
      if (FORBIDDEN_VARIABLE_NAMES.has(node.name)) {
        throw new MathExprError(`未知变量「${node.name}」`)
      }
      const value = values.get(node.name)
      if (typeof value !== 'number') throw new MathExprError(`未知变量「${node.name}」`)
      return value
    }
    case 'unary': {
      const value = evaluateAst(node.operand, values)
      return node.operator === '-' ? -value : value
    }
    case 'binary': {
      const left = evaluateAst(node.left, values)
      const right = evaluateAst(node.right, values)
      switch (node.operator) {
        case '+': return left + right
        case '-': return left - right
        case '*': return left * right
        case '/': return left / right
        case '^': return Math.pow(left, right)
        case '<': return left < right ? 1 : 0
        case '<=': return left <= right ? 1 : 0
        case '>': return left > right ? 1 : 0
        case '>=': return left >= right ? 1 : 0
        case '==': return left === right ? 1 : 0
        case '!=': return left !== right ? 1 : 0
      }
    }
    case 'conditional':
      return evaluateAst(node.condition, values)
        ? evaluateAst(node.whenTrue, values)
        : evaluateAst(node.whenFalse, values)
    case 'call':
      return evaluateCall(node.name, node.args, values)
  }
}

export function compileMathExpression(source: string): CompiledMathExpression {
  if (source.length > MATH_EXPR_MAX_LENGTH) {
    throw new MathExprError(`表达式长度不能超过 ${MATH_EXPR_MAX_LENGTH}`)
  }
  const { ast, variables } = new Parser(lex(source)).parse()
  return Object.freeze({
    source,
    variables,
    evaluate(values: ReadonlyMap<string, number>): number {
      return evaluateAst(ast, values)
    }
  })
}

export function evaluateMathExpression(
  source: string,
  values: ReadonlyMap<string, number> = new Map<string, number>()
): number {
  return compileMathExpression(source).evaluate(values)
}
