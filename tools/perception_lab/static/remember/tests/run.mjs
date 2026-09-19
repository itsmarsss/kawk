// Run: node tools/perception_lab/static/remember/tests/run.mjs
import * as h from './harness.mjs';
import * as storeTests from './store_test.mjs';
import * as providerTests from './demo_provider_test.mjs';
import * as liveTests from './live_adapter_test.mjs';
import * as captureTests from './live_capture_test.mjs';
import * as lcdTests from './lcd_test.mjs';
import * as v1Tests from './v1_provider_test.mjs';
import * as decisionRender from './decision_render_test.mjs';
import * as overlayTests from './overlay_test.mjs';
import * as deletionTests from './deletion_test.mjs';
import * as memoryRender from './memory_render_test.mjs';
import * as speechReconnect from './speech_reconnect_test.mjs';

storeTests.run();
await providerTests.run();
await liveTests.run();
await captureTests.run();
await speechReconnect.run();
await lcdTests.run();
await v1Tests.run();
await v1Tests.runSpeechReconnect();
await decisionRender.run();
await memoryRender.run();
overlayTests.run();
await deletionTests.run();
console.log(`\n${h.passes} passed, ${h.failures} failed`);
process.exit(h.failures ? 1 : 0);
