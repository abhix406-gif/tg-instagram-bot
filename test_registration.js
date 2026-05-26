import { requestOTP } from './src/whatsapp/service.js';

async function testDeprecatedSmsFlow() {
  const result = await requestOTP();
  console.log(result.message);
}

testDeprecatedSmsFlow().catch((error) => {
  console.error(error);
  process.exit(1);
});
