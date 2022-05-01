// Modified from https://github.com/rlidwka/jju/blob/master/lib/parse.js

const Uni = require('./unicode')

function isHexDigit (x) {
  return (x >= '0' && x <= '9') ||
      (x >= 'A' && x <= 'F') ||
      (x >= 'a' && x <= 'f')
}

function isOctDigit (x) {
  return x >= '0' && x <= '7'
}

function isDecDigit (x) {
  return x >= '0' && x <= '9'
}

const unescapeMap = {
  '\'': '\'',
  '"': '"',
  '\\': '\\',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '/': '/'
}

function formatError (input, message, position, lineNumber, column, json5) {
  const result = message + ' at ' + (lineNumber + 1) + ':' + (column + 1)

  let startPosition = position - column - 1

  let sourceLine = ''

  let underline = ''

  const isLineTerminator = json5 ? Uni.isLineTerminator : Uni.isLineTerminatorJSON

  // output no more than 70 characters before the wrong ones
  if (startPosition < position - 70) {
    startPosition = position - 70
  }

  while (1) {
    const chr = input[++startPosition]

    if (isLineTerminator(chr) || startPosition === input.length) {
      if (position >= startPosition) {
        // ending line error, so show it after the last char
        underline += '^'
      }
      break
    }
    sourceLine += chr

    if (position === startPosition) {
      underline += '^'
    } else if (position > startPosition) {
      underline += input[startPosition] === '\t' ? '\t' : ' '
    }

    // output no more than 78 characters on the string
    if (sourceLine.length > 78) break
  }

  return result + '\n' + sourceLine + '\n' + underline
}

function parse (input, options) {
  // parse as a standard JSON mode
  let json5 = false
  let cjson = false

  if (options.legacy || options.mode === 'json') {
    // use json
  } else if (options.mode === 'cjson') {
    cjson = true
  } else if (options.mode === 'json5') {
    json5 = true
  } else {
    // use it by default
    json5 = true
  }

  const isLineTerminator = json5 ? Uni.isLineTerminator : Uni.isLineTerminatorJSON
  const isWhiteSpace = json5 ? Uni.isWhiteSpace : Uni.isWhiteSpaceJSON

  const length = input.length

  let lineNumber = 0
  let lineStart = 0
  let position = 0

  let startToken
  let endToken
  let tokenPath

  const tokenize = options.tokenize
  if (tokenize) {
    var tokens = []
    let tokenOffset = null
    let tokenLine
    let tokenColumn
    startToken = function () {
      if (tokenOffset !== null) throw Error('internal error, token overlap')
      tokenLine = lineNumber + 1
      tokenColumn = position - lineStart + 1
      tokenOffset = position
    }
    endToken = function (v, type) {
      if (tokenOffset !== position) {
        const token = {
          raw: input.substr(tokenOffset, position - tokenOffset),
          type,
          location: {
            start: {
              line: tokenLine,
              column: tokenColumn,
              offset: tokenOffset
            }
          },
          path: tokenPath.slice()
        }
        if (v !== undefined) {
          token.value = v
        }
        tokens.push(token)
      }
      tokenOffset = null
      return v
    }
    tokenPath = []
  }

  function fail (message) {
    const column = position - lineStart

    if (!message) {
      if (position < length) {
        const token = '\'' +
          JSON
            .stringify(input[position])
            .replace(/^"|"$/g, '')
            .replace(/'/g, "\\'")
            .replace(/\\"/g, '"') +
          '\''

        if (!message) message = 'Unexpected token ' + token
      } else {
        if (!message) message = 'Unexpected end of input'
      }
    }

    const error = SyntaxError(formatError(input, message, position, lineNumber, column, json5))
    error.row = lineNumber + 1
    error.column = column + 1
    throw error
  }

  function newLine (chr) {
    // account for <cr><lf>
    if (chr === '\r' && input[position] === '\n') position++
    lineStart = position
    lineNumber++
  }

  function parseGeneric () {
    while (position < length) {
      startToken && startToken()
      const chr = input[position++]

      if (chr === '"' || (chr === '\'' && json5)) {
        const string = parseString(chr)
        endToken && endToken(string, 'literal')
        return string
      } else if (chr === '{') {
        endToken && endToken('{', 'separator')
        return parseObject()
      } else if (chr === '[') {
        endToken && endToken('[', 'separator')
        return parseArray()
      } else if (chr === '-' ||
             chr === '.' ||
             isDecDigit(chr) ||
      //           + number       Infinity          NaN
             (json5 && (chr === '+' || chr === 'I' || chr === 'N'))
      ) {
        const number = parseNumber()
        endToken && endToken(number, 'literal')
        return number
      } else if (chr === 'n') {
        parseKeyword('null')
        endToken && endToken(null, 'literal')
        return null
      } else if (chr === 't') {
        parseKeyword('true')
        endToken && endToken(true, 'literal')
        return true
      } else if (chr === 'f') {
        parseKeyword('false')
        endToken && endToken(false, 'literal')
        return false
      } else {
        position--
        endToken && endToken(undefined)
        return undefined
      }
    }
  }

  function parseKey () {
    let result

    while (position < length) {
      startToken && startToken()
      const chr = input[position++]

      if (chr === '"' || (chr === '\'' && json5)) {
        const string = parseString(chr)
        endToken && endToken(string, 'key')
        return string
      } else if (chr === '{') {
        endToken && endToken('{', 'separator')
        return parseObject()
      } else if (chr === '[') {
        endToken && endToken('[', 'separator')
        return parseArray()
      } else if (chr === '.' || isDecDigit(chr)
      ) {
        const number = parseNumber(true)
        endToken && endToken(number, 'key')
        return number
      } else if ((json5 && Uni.isIdentifierStart(chr)) ||
                 (chr === '\\' && input[position] === 'u')) {
        // unicode char or a unicode sequence
        const rollback = position - 1
        result = parseIdentifier()

        if (result === undefined) {
          position = rollback
          endToken && endToken(undefined)
          return undefined
        } else {
          endToken && endToken(result, 'key')
          return result
        }
      } else {
        position--
        endToken && endToken(undefined)
        return undefined
      }
    }
  }

  function skipWhiteSpace () {
    let whitespaceStart
    function startWhiteSpace () {
      if (whitespaceStart === undefined) {
        whitespaceStart = --position
        startToken()
        ++position
      }
    }
    function endWhiteSpace () {
      if (whitespaceStart >= 0) {
        endToken(input.substring(whitespaceStart, position), 'whitespace')
        whitespaceStart = undefined
      }
    }
    while (position < length) {
      const char = input[position++]
      if (isLineTerminator(char)) {
        startToken && startWhiteSpace()
        newLine(char)
      } else if (isWhiteSpace(char)) {
        startToken && startWhiteSpace()
      } else if (char === '/' &&
             (json5 || cjson) &&
             (input[position] === '/' || input[position] === '*')) {
        var startPosition
        if (startToken) {
          startPosition = --position
          endWhiteSpace()
          startToken()
          ++position
        }
        skipComment(input[position++] === '*')
        endToken && endToken(input.substring(startPosition, position), 'comment')
      } else {
        --position
        break
      }
    }
    endToken && endWhiteSpace()
  }

  function skipComment (multi) {
    while (position < length) {
      const chr = input[position++]

      if (isLineTerminator(chr)) {
        // LineTerminator is an end of singleline comment
        if (!multi) {
          // let parent function deal with newline
          position--
          return
        }

        newLine(chr)
      } else if (chr === '*' && multi) {
        // end of multiline comment
        if (input[position] === '/') {
          position++
          return
        }
      } else {
        // nothing
      }
    }

    if (multi) {
      fail('Unclosed multiline comment')
    }
  }

  function parseKeyword (keyword) {
    // keyword[0] is not checked because it should've checked earlier
    const startPosition = position
    const len = keyword.length
    for (let i = 1; i < len; i++) {
      if (position >= length || keyword[i] !== input[position]) {
        position = startPosition - 1
        fail()
      }
      position++
    }
  }

  function parseObject () {
    const result = options.null_prototype ? Object.create(null) : {}
    const emptyObject = {}
    let isNotEmpty = false

    while (position < length) {
      skipWhiteSpace()
      const key = parseKey()
      skipWhiteSpace()
      startToken && startToken()
      let chr = input[position++]
      endToken && endToken(undefined, 'separator')

      if (chr === '}' && key === undefined) {
        if (!json5 && isNotEmpty) {
          position--
          fail('Trailing comma in object')
        }
        return result
      } else if (chr === ':' && key !== undefined) {
        skipWhiteSpace()
        tokenPath && tokenPath.push(key)
        let value = parseGeneric()
        tokenPath && tokenPath.pop()

        if (value === undefined) fail('No value found for key ' + key)
        if (typeof (key) !== 'string') {
          if (!json5 || typeof (key) !== 'number') {
            fail('Wrong key type: ' + key)
          }
        }

        if ((key in emptyObject || emptyObject[key] != null) && options.reserved_keys !== 'replace') {
          if (options.reserved_keys === 'throw') {
            fail('Reserved key: ' + key)
          } else {
            // silently ignore it
          }
        } else {
          if (typeof (options.reviver) === 'function') {
            value = options.reviver.call(null, key, value)
          }

          if (value !== undefined) {
            isNotEmpty = true
            Object.defineProperty(result, key, {
              value,
              enumerable: true,
              configurable: true,
              writable: true
            })
          }
        }

        skipWhiteSpace()

        startToken && startToken()
        chr = input[position++]
        endToken && endToken(undefined, 'separator')

        if (chr === ',') {
          continue
        } else if (chr === '}') {
          return result
        } else {
          fail()
        }
      } else {
        position--
        fail()
      }
    }

    fail()
  }

  function parseArray () {
    const result = []

    while (position < length) {
      skipWhiteSpace()
      tokenPath && tokenPath.push(result.length)
      let item = parseGeneric()
      tokenPath && tokenPath.pop()
      skipWhiteSpace()
      startToken && startToken()
      const chr = input[position++]
      endToken && endToken(undefined, 'separator')

      if (item !== undefined) {
        if (typeof (options.reviver) === 'function') {
          item = options.reviver.call(null, String(result.length), item)
        }
        if (item === undefined) {
          result.length++
          item = true // hack for check below, not included into result
        } else {
          result.push(item)
        }
      }

      if (chr === ',') {
        if (item === undefined) {
          fail('Elisions are not supported')
        }
      } else if (chr === ']') {
        if (!json5 && item === undefined && result.length) {
          position--
          fail('Trailing comma in array')
        }
        return result
      } else {
        position--
        fail()
      }
    }
  }

  function parseNumber () {
    // rewind because we don't know first char
    position--

    let start = position

    let chr = input[position++]

    const toNumber = function (isOctal) {
      const str = input.substr(start, position - start)
      let result

      if (isOctal) {
        result = parseInt(str.replace(/^0o?/, ''), 8)
      } else {
        result = Number(str)
      }

      if (Number.isNaN(result)) {
        position--
        fail('Bad numeric literal - "' + input.substr(start, position - start + 1) + '"')
      } else if (!json5 && !str.match(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?(e[+-]?[0-9]+)?$/i)) {
        // additional restrictions imposed by json
        position--
        fail('Non-json numeric literal - "' + input.substr(start, position - start + 1) + '"')
      } else {
        return result
      }
    }

    // ex: -5982475.249875e+29384
    //     ^ skipping this
    if (chr === '-' || (chr === '+' && json5)) chr = input[position++]

    if (chr === 'N' && json5) {
      parseKeyword('NaN')
      return NaN
    }

    if (chr === 'I' && json5) {
      parseKeyword('Infinity')

      // returning +inf or -inf
      return toNumber()
    }

    if (chr >= '1' && chr <= '9') {
      // ex: -5982475.249875e+29384
      //        ^^^ skipping these
      while (position < length && isDecDigit(input[position])) position++
      chr = input[position++]
    }

    // special case for leading zero: 0.123456
    if (chr === '0') {
      chr = input[position++]

      //             new syntax, "0o777"           old syntax, "0777"
      const isOctal = chr === 'o' || chr === 'O' || isOctDigit(chr)
      const isHex = chr === 'x' || chr === 'X'

      if (json5 && (isOctal || isHex)) {
        while (position < length &&
           (isHex ? isHexDigit : isOctDigit)(input[position])
        ) position++

        let sign = 1
        if (input[start] === '-') {
          sign = -1
          start++
        } else if (input[start] === '+') {
          start++
        }

        return sign * toNumber(isOctal)
      }
    }

    if (chr === '.') {
      // ex: -5982475.249875e+29384
      //                ^^^ skipping these
      while (position < length && isDecDigit(input[position])) position++
      chr = input[position++]
    }

    if (chr === 'e' || chr === 'E') {
      chr = input[position++]
      if (chr === '-' || chr === '+') position++
      // ex: -5982475.249875e+29384
      //                       ^^^ skipping these
      while (position < length && isDecDigit(input[position])) position++
      chr = input[position++]
    }

    // we have char in the buffer, so count for it
    position--
    return toNumber()
  }

  function parseIdentifier () {
    // rewind because we don't know first char
    position--

    let result = ''

    while (position < length) {
      let chr = input[position++]

      if (chr === '\\' &&
      input[position] === 'u' &&
      isHexDigit(input[position + 1]) &&
      isHexDigit(input[position + 2]) &&
      isHexDigit(input[position + 3]) &&
      isHexDigit(input[position + 4])
      ) {
        // UnicodeEscapeSequence
        chr = String.fromCharCode(parseInt(input.substr(position + 1, 4), 16))
        position += 5
      }

      if (result.length) {
        // identifier started
        if (Uni.isIdentifierPart(chr)) {
          result += chr
        } else {
          position--
          return result
        }
      } else {
        if (Uni.isIdentifierStart(chr)) {
          result += chr
        } else {
          return undefined
        }
      }
    }

    fail()
  }

  function parseString (endChar) {
    // 7.8.4 of ES262 spec
    let result = ''

    while (position < length) {
      let chr = input[position++]

      if (chr === endChar) {
        return result
      } else if (chr === '\\') {
        if (position >= length) fail()
        chr = input[position++]

        if (unescapeMap[chr] && (json5 || (chr !== 'v' && chr !== "'"))) {
          result += unescapeMap[chr]
        } else if (json5 && isLineTerminator(chr)) {
          // line continuation
          newLine(chr)
        } else if (chr === 'u' || (chr === 'x' && json5)) {
          // unicode/character escape sequence
          const off = chr === 'u' ? 4 : 2

          // validation for \uXXXX
          for (let i = 0; i < off; i++) {
            if (position >= length) fail()
            if (!isHexDigit(input[position])) fail('Bad escape sequence')
            position++
          }

          result += String.fromCharCode(parseInt(input.substr(position - off, off), 16))
        } else if (json5 && isOctDigit(chr)) {
          var digits
          if (chr < '4' && isOctDigit(input[position]) && isOctDigit(input[position + 1])) {
            // three-digit octal
            digits = 3
          } else if (isOctDigit(input[position])) {
            // two-digit octal
            digits = 2
          } else {
            digits = 1
          }
          position += digits - 1
          result += String.fromCharCode(parseInt(input.substr(position - digits, digits), 8))
          /* if (!isOctDigit(input[position])) {
            // \0 is allowed still
            result += '\0'
          } else {
            fail('Octal literals are not supported')
          } */
        } else if (json5) {
          // \X -> x
          result += chr
        } else {
          position--
          fail()
        }
      } else if (isLineTerminator(chr)) {
        fail()
      } else {
        if (!json5 && chr.charCodeAt(0) < 32) {
          position--
          fail('Unexpected control character')
        }

        // SourceCharacter but not one of " or \ or LineTerminator
        result += chr
      }
    }

    fail()
  }

  skipWhiteSpace()
  let returnValue = parseGeneric()
  if (returnValue !== undefined || position < length) {
    skipWhiteSpace()

    if (position >= length) {
      if (typeof (options.reviver) === 'function') {
        returnValue = options.reviver.call(null, '', returnValue)
      }
      if (tokenize) {
        return {
          value: returnValue,
          tokens
        }
      }
      return returnValue
    } else {
      fail()
    }
  } else {
    if (position) {
      fail('No data, only a whitespace')
    } else {
      fail('No data, empty input')
    }
  }
}

/*
 * parse(text, options)
 * or
 * parse(text, reviver)
 *
 * where:
 * text - string
 * options - object
 * reviver - function
 */
exports.parse = function parseJSON (input, options) {
  // support legacy functions
  if (typeof (options) === 'function') {
    options = {
      reviver: options
    }
  }

  // JSON.parse compat
  if (typeof input !== 'string' || !(input instanceof String)) input = String(input)
  if (options == null) options = {}
  if (options.reserved_keys == null) options.reserved_keys = 'ignore'

  if (options.reserved_keys === 'throw' || options.reserved_keys === 'ignore') {
    if (options.null_prototype == null) {
      options.null_prototype = true
    }
  }

  try {
    return parse(input, options)
  } catch (error) {
    // jju is a recursive parser, so JSON.parse("{{{{{{{") could blow up the stack
    //
    // this catch is used to skip all those internal calls
    if (error instanceof SyntaxError && error.row != null && error.column != null) {
      const syntaxError = SyntaxError(error.message)
      syntaxError.column = error.column
      syntaxError.row = error.row
      throw syntaxError
    }
    throw error
  }
}
