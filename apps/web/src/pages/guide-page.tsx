import { CppOptimizationGuide } from "../components/contest/cpp-optimization-guide.js";
import { PageHeader } from "../components/ui.js";

export function GuidePage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="解説"
        description="C++の実装を、短いナイーブ版から段階的に改善します。"
      />
      <CppOptimizationGuide />
    </div>
  );
}
