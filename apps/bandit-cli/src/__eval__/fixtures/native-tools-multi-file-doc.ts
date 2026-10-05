import type { Fixture } from '../types';
import { targetedEditOf } from './shared';

/**
 * Native-tool-calling smoke test. Built specifically to grade the  * native-tools path on capable Ollama models (Qwen2.5-Coder-32B, Llama 3.1+,
 * Devstral, DeepSeek-Coder-V2+, etc.) against the same task the 12B Gemma
 * variant thrashed on (S3Api/.bandit/turns/turn-2026-04-22T05-06-03-961Z-mf15:
 * 8 single-tool iterations, maxIterations hit, apologetic final response).
 *
 * A well-behaved capable model on the native path should:
 * - Read both files (parallel tool calls OK).
 * - Edit both files with apply_edit, adding XML documentation comments.
 * - Finish in ≤4 iterations.
 * - Emit NO json_todo_auto_promoted / fake_tool_result_detected /
 * prose_loop_nudge telemetry — all those are small-model crutches.
 *
 * Assertions below check tool usage + iteration budget. The eval harness's
 * separate event-counting assertions can confirm the mitigation detectors
 * stayed dormant.
 *
 * @type {import('@burtson-labs/bandit-stealth-cli').Fixture}
 */
export const fixture: Fixture = {
  id: 'native_tools.multi_file_doc_add',
  description: 'Capable model + native tools: add XML docs to two C# controllers in ≤4 iterations',
  prompt: 'Add meaningful XML documentation comments to the class and public methods of both controllers.',
  setup: {
    files: {
      'src/Controllers/HealthController.cs': [
        'using Microsoft.AspNetCore.Mvc;',
        '',
        'namespace DemoApi.Controllers',
        '{',
        '    [ApiController]',
        '    [Route("api/[controller]")]',
        '    public class HealthController : ControllerBase',
        '    {',
        '        [HttpGet]',
        '        public IActionResult Get()',
        '        {',
        '            return Ok(new { status = "healthy" });',
        '        }',
        '    }',
        '}',
        ''
      ].join('\n'),
      'src/Controllers/FileController.cs': [
        'using Microsoft.AspNetCore.Mvc;',
        '',
        'namespace DemoApi.Controllers',
        '{',
        '    [ApiController]',
        '    [Route("api/[controller]")]',
        '    public class FileController : ControllerBase',
        '    {',
        '        [HttpPost("upload")]',
        '        public IActionResult Upload()',
        '        {',
        '            return Ok();',
        '        }',
        '',
        '        [HttpGet("{id}")]',
        '        public IActionResult Download(string id)',
        '        {',
        '            return Ok();',
        '        }',
        '    }',
        '}',
        ''
      ].join('\n')
    }
  },
  assertions: {
    // Both files must actually be edited — this is the bar the 12B missed
    // (it edited FileController repeatedly but dropped HealthController in
    // parallel-apply-edit traces).
    // Any targeted edit counts: apply_edit, replace_range, or one apply_patch
    // covering both files (which is what the apply_patch description tells
    // the model to use for a 2+ file change).
    mustCallAllOf: [
      targetedEditOf('HealthController.cs'),
      targetedEditOf('FileController.cs')
    ],
    // write_file would be wrong here — we want targeted edits, not full
    // file rewrites.
    mustNotCall: ['write_file'],
    // The docs have to be in the files.
    finalFiles: {
      'src/Controllers/HealthController.cs': /\/\/\/\s*<summary>/,
      'src/Controllers/FileController.cs': /\/\/\/\s*<summary>/
    },
    // A native-tools capable model should finish this in 2-3 iterations.
    // We give a small buffer because the eval also runs on weaker models
    // to compare the spread; anything over 4 iterations means the model
    // is thrashing and the test fails loudly.
    maxIterations: 4,
    // The final response should acknowledge both files were updated.
    // Regex is permissive — both controller names anywhere in the summary
    // (a bulleted list puts them on separate lines, which the old
    // single-line pattern missed), or "both". Stochastic summaries are
    // common so we don't over-specify wording.
    finalResponseMatches: /(?=[\s\S]*Health)(?=[\s\S]*File)|\bboth\b/i
  },
  // Run 3× for stability; 2/3 passes to guard against a single stochastic
  // miss. Capable models should hit 3/3 comfortably.
  runs: 3,
  passThreshold: 2,
  maxIterations: 5
};
