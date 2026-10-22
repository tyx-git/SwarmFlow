/** 随程序发布的注册表只包含 provider 连接元数据。 */

import { FACTORY_PROVIDER_SPECS } from "./provider-specs.js";
import type { ProviderSpec } from "./provider-specs.js";

export const EFFECTIVE_PROVIDER_SPECS: ProviderSpec[] = FACTORY_PROVIDER_SPECS;
