-- DropForeignKey
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_themeId_fkey";

-- DropForeignKey
ALTER TABLE "theme_font_fetches" DROP CONSTRAINT "theme_font_fetches_themeId_fkey";

-- DropForeignKey
ALTER TABLE "theme_fonts" DROP CONSTRAINT "theme_fonts_fontHash_fkey";

-- DropForeignKey
ALTER TABLE "theme_fonts" DROP CONSTRAINT "theme_fonts_themeId_fkey";

-- AlterTable
ALTER TABLE "profiles" DROP COLUMN "themeId";

-- DropTable
DROP TABLE "theme_font_fetches";

-- DropTable
DROP TABLE "theme_fonts";

-- DropTable
DROP TABLE "themes";

-- DropEnum
DROP TYPE "ColorScheme";

-- DropEnum
DROP TYPE "FetchState";

-- DropEnum
DROP TYPE "ThemeSource";

