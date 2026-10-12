import { useTranslation } from "react-i18next";
import { LabelsManager } from "../../ui/LabelsManager";
import { Section } from "../../ui/Section";
import { Tag } from "../../ui/icons";

export function LabelsSection() {
  const { t } = useTranslation();
  return (
    <Section icon={Tag} title={t("label.manage")}>
      <LabelsManager />
    </Section>
  );
}
